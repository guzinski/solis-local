// Reads the stick on a fixed interval over one persistent connection, and works out
// what kind of trouble it's in when reads fail. The stick is unpowered at night
// on a grid-tied inverter, so failures after sunset are normal.
//
// Failure kinds, from what we've seen on the S5-WIFI-ST:
//   busy         refused or slow for a few minutes (it serves one client at a
//                time and is often occupied, e.g. uploading); it clears by itself
//   modbus-down  refused for STUCK_MINUTES straight: the stick is up (it answers
//                TCP) but its Modbus server has stopped; only a stick restart helps
//   unreachable  nothing answers at the address: night, or a new DHCP address,
//                which we look for automatically
//   asleep       refused or silent while the sun is too low: at dusk the inverter
//                shuts down first and the stick, still on for a while, refuses
//                Modbus with nothing behind it (seen 2026-11-08 19:04-19:30);
//                at dawn the stick may boot before the inverter is ready
import type { Config } from "./env.ts";
import { BLOCK_COUNT, BLOCK_START, decode, plausible, type Reading } from "./inverter.ts";
import { locateStick } from "./locate.ts";
import { ModbusConnection, ModbusException, newTrace, type LinkEvent, type Trace } from "./modbus.ts";
import { notify, OutageAlert } from "./alert.ts";
import type { Store } from "./store.ts";

export type Diagnosis = "ok" | "busy" | "modbus-down" | "unreachable" | "asleep";

export type LinkState = {
  checked: boolean;     // false until the first read attempt has finished
  online: boolean;
  lastSeen: number | null;
  lastAttempt: number | null;
  lastError: string | null;
  diagnosis: Diagnosis | null;
  failingSince: number | null; // first failed poll of the current outage
  host: string;                // address in use (may differ from .env.local after a DHCP change)
};

// The stick needs time after one client leaves before it accepts the next, so
// a retry a few seconds later just gets refused again. Wait longer, retry once.
const RETRY_DELAY_MS = 20_000;
const STUCK_MINUTES = 10;
const LOCATE_AFTER_FAILS = 3;       // unreachable polls in a row before scanning the LAN
const LOCATE_EVERY_MS = 15 * 60_000;
const HOST_META = "stick_host";     // {configured, found}: an address found by scanning

// Below this much solar input the inverter is about to shut down (or just woke up).
const LOW_SUN_W = 300;

const UNREACHABLE = new Set(["EHOSTUNREACH", "ENETUNREACH", "EHOSTDOWN", "ETIMEDOUT"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clock = (ts: number) => new Date(ts).toLocaleTimeString("sv");
const daylight = (now = new Date()) => now.getHours() >= 6 && now.getHours() < 19;

type Failure = { err: Error; code: string | null; trace: Trace };

export class Poller {
  state: LinkState;
  config: Config;
  store: Store;
  alert: OutageAlert;
  conn: ModbusConnection;
  unreachableTicks = 0;
  lastLocate = 0;
  timer: NodeJS.Timeout | null = null;
  stopped = false;

  constructor(config: Config, store: Store) {
    this.config = config;
    this.store = store;
    this.alert = new OutageAlert(config.alertMinutes);
    this.state = {
      checked: false, online: false, lastSeen: store.latest()?.ts ?? null, lastAttempt: null, lastError: null,
      diagnosis: null, failingSince: null, host: this.savedHost() ?? config.stickHost,
    };
    if (this.state.host !== config.stickHost) {
      console.log(`using ${this.state.host} (found by scanning; .env.local says ${config.stickHost})`);
    }
    this.conn = this.connect(this.state.host);
  }

  connect(host: string): ModbusConnection {
    return new ModbusConnection(host, this.config.stickPort, (e) => this.event(e));
  }

  event(e: LinkEvent): void {
    const now = Date.now();
    if (e.kind !== "open") console.log(`${clock(now)} connection ${e.kind}: ${e.detail}`);
    try {
      this.store.logEvent(now, e.kind, e.detail, this.state.host);
    } catch (err) {
      console.log(`event log failed: ${(err as Error).message}`);
    }
  }

  // A scanned address only counts while .env.local still holds the address it replaced,
  // so editing .env.local always wins.
  savedHost(): string | null {
    try {
      const saved = JSON.parse(this.store.getMeta(HOST_META) ?? "null") as { configured: string; found: string } | null;
      return saved && saved.configured === this.config.stickHost ? saved.found : null;
    } catch {
      return null;
    }
  }

  async attempt(tickTs: number, n: number): Promise<Reading | Failure> {
    const ts = Date.now();
    const trace = newTrace();
    try {
      const regs = await this.conn.read({ unit: this.config.stickUnit, start: BLOCK_START, count: BLOCK_COUNT }, trace);
      const reading = decode(regs);
      if (!plausible(reading)) throw new Error("implausible values; discarded");
      this.record(ts, tickTs, n, trace, null, null);
      return reading;
    } catch (e) {
      const err = e as Error;
      const code = (err as NodeJS.ErrnoException).code
        ?? (err instanceof ModbusException ? `MODBUS_${err.code}` : err.message === "timed out" ? `TIMEOUT_${trace.phase}` : null);
      this.record(ts, tickTs, n, trace, err, code);
      return { err, code, trace };
    }
  }

  // Unreachable = nothing answered at the address. A refusal means the stick's
  // TCP stack answered, so it's there; a timeout after connecting means it's slow.
  isUnreachable(f: Failure): boolean {
    return f.trace.phase === "connect" && (UNREACHABLE.has(f.code ?? "") || f.code === "TIMEOUT_connect");
  }

  diagnose(f: Failure, failingSince: number, now: number): Diagnosis {
    if (this.isUnreachable(f)) return "unreachable";
    const last = this.store.latest();
    if (!last || last.pvW < LOW_SUN_W) return "asleep";
    if (f.code === "ECONNREFUSED" && now - failingSince >= STUCK_MINUTES * 60_000) return "modbus-down";
    return "busy";
  }

  async tick(): Promise<void> {
    const tickTs = Date.now();
    this.state.lastAttempt = tickTs;
    // Retry once while it looks transient; when it's clearly down, one probe per poll is enough.
    const d = this.state.diagnosis;
    const tries = d === "modbus-down" || d === "unreachable" || d === "asleep" ? 1 : 2;
    let result: Reading | Failure | null = null;
    for (let n = 1; n <= tries; n++) {
      if (n > 1) await sleep(RETRY_DELAY_MS);
      result = await this.attempt(tickTs, n);
      if (!("err" in result)) break;
      if (this.isUnreachable(result)) break; // retrying won't help; the scan below might
    }
    if (result && !("err" in result)) this.succeeded(result);
    else if (result) await this.failed(result, tickTs);
    this.alert.check(this.state, this.store.latest());
  }

  succeeded(reading: Reading): void {
    this.store.save(reading);
    if (!this.state.online) {
      const outage = this.state.failingSince ? ` after ${Math.round((reading.ts - this.state.failingSince) / 60_000)} min (${this.state.diagnosis})` : "";
      console.log(`${clock(reading.ts)} stick online: ${reading.acW} W${outage}`);
    }
    this.unreachableTicks = 0;
    this.state = {
      ...this.state, checked: true, online: true, lastSeen: reading.ts, lastError: null,
      diagnosis: "ok", failingSince: null,
    };
  }

  async failed(f: Failure, tickTs: number): Promise<void> {
    const failingSince = this.state.failingSince ?? tickTs;
    const diagnosis = this.diagnose(f, failingSince, tickTs);
    if (diagnosis !== this.state.diagnosis) {
      console.log(`${clock(tickTs)} stick ${diagnosis}: ${f.err.message}`);
    }
    this.state = { ...this.state, checked: true, online: false, lastError: f.err.message, diagnosis, failingSince };
    this.unreachableTicks = diagnosis === "unreachable" ? this.unreachableTicks + 1 : 0;
    // Also search when "Modbus stopped": if the router handed our old address to
    // another device, that device refuses connections just like a crashed stick.
    if (
      (this.unreachableTicks >= LOCATE_AFTER_FAILS || diagnosis === "modbus-down") && daylight() &&
      Date.now() - this.lastLocate >= LOCATE_EVERY_MS
    ) {
      await this.relocate();
    }
  }

  // The address stopped answering in daylight: the router may have handed the stick a new one.
  async relocate(): Promise<void> {
    this.lastLocate = Date.now();
    console.log(`${clock(this.lastLocate)} looking for the stick on the LAN…`);
    const { host, candidates } = await locateStick(this.state.host);
    if (!host) {
      console.log(candidates.length > 1
        ? `found several Solis sticks (${candidates.join(", ")}); not switching`
        : "stick not found on the LAN (it may be off)");
      return;
    }
    if (host === this.state.host) return;
    console.log(`stick moved: ${this.state.host} -> ${host}`);
    notify("Solar: stick changed address", `Now reading from ${host}. A DHCP reservation in the router stops this.`);
    await this.conn.close("stick moved");
    this.state.host = host;
    this.conn = this.connect(host);
    this.unreachableTicks = 0;
    try {
      this.store.setMeta(HOST_META, JSON.stringify({ configured: this.config.stickHost, found: host }));
    } catch (e) {
      console.log(`could not save new address: ${(e as Error).message}`);
    }
  }

  // Diagnostics must never break polling, so logging errors are swallowed.
  // Failures are printed only while things look transient, to keep night quiet.
  record(ts: number, tickTs: number, n: number, trace: Trace, err: Error | null, code: string | null): void {
    if (err && (this.state.diagnosis === "ok" || this.state.diagnosis === "busy" || this.state.diagnosis === null)) {
      console.log(`${clock(ts)} attempt ${n} failed at ${trace.phase}: ${err.message} (${trace.totalMs ?? "?"} ms)`);
    }
    try {
      this.store.logAttempt({
        ts, tickTs, attempt: n, ok: !err, phase: trace.phase, code, error: err?.message ?? null,
        connectMs: trace.connectMs, totalMs: trace.totalMs, localPort: trace.localPort, bytes: trace.bytes,
        reused: trace.reused, connReads: trace.connReads, connAgeMs: trace.connAgeMs, host: this.state.host,
      });
    } catch (e) {
      console.log(`attempt log failed: ${(e as Error).message}`);
    }
  }

  start(): void {
    const loop = async () => {
      const began = Date.now();
      try {
        await this.tick();
      } catch (e) {
        console.log(`poll failed unexpectedly: ${(e as Error).message}`); // never stop polling
      }
      if (this.stopped) return;
      this.timer = setTimeout(loop, Math.max(1000, this.config.pollSeconds * 1000 - (Date.now() - began)));
    };
    void loop();
  }

  // Close the connection politely so the stick frees its slot before we exit.
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.conn.close("shutting down");
  }
}
