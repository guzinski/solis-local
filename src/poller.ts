// Reads the stick on a fixed interval, one connection at a time. The stick is
// unpowered at night on a grid-tied inverter, so failures after sunset are normal.
import type { Config } from "./env.ts";
import { BLOCK_COUNT, BLOCK_START, decode, plausible, type Reading } from "./inverter.ts";
import { readInputRegisters } from "./modbus.ts";
import { OutageAlert } from "./alert.ts";
import type { Store } from "./store.ts";

export type LinkState = {
  checked: boolean;     // false until the first read attempt has finished
  online: boolean;
  lastSeen: number | null;
  lastAttempt: number | null;
  lastError: string | null;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Poller {
  state: LinkState = { checked: false, online: false, lastSeen: null, lastAttempt: null, lastError: null };
  config: Config;
  store: Store;
  alert: OutageAlert;

  constructor(config: Config, store: Store) {
    this.config = config;
    this.store = store;
    this.alert = new OutageAlert(config.alertMinutes);
    this.state.lastSeen = store.latest()?.ts ?? null;
  }

  async readOnce(): Promise<Reading> {
    let lastError: unknown;
    // The stick refuses connections while busy (e.g. uploading); a few slow retries.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(3000);
      try {
        const regs = await readInputRegisters({
          host: this.config.stickHost, port: this.config.stickPort, unit: this.config.stickUnit,
          start: BLOCK_START, count: BLOCK_COUNT,
        });
        const reading = decode(regs);
        if (!plausible(reading)) throw new Error("implausible values; discarded");
        return reading;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  async tick(): Promise<void> {
    this.state.lastAttempt = Date.now();
    try {
      const reading = await this.readOnce();
      this.store.save(reading);
      if (!this.state.online) console.log(`stick online: ${reading.acW} W`);
      this.state = { ...this.state, checked: true, online: true, lastSeen: reading.ts, lastError: null };
    } catch (err) {
      const message = (err as Error).message;
      if (this.state.online) console.log(`stick unreachable: ${message}`);
      this.state = { ...this.state, checked: true, online: false, lastError: message };
    }
    this.alert.check(this.state, this.store.latest());
  }

  start(): void {
    const loop = async () => {
      const began = Date.now();
      await this.tick();
      setTimeout(loop, Math.max(1000, this.config.pollSeconds * 1000 - (Date.now() - began)));
    };
    void loop();
  }
}
