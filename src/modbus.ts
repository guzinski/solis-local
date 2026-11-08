// Minimal Modbus TCP client. It implements only function code 04 (Read Input
// Registers), so nothing in this app can change an inverter setting.
//
// It keeps ONE connection open and reuses it for every read. The Solis stick
// serves very few clients and doesn't reliably free a slot when a connection
// closes, so opening a fresh connection per read can use them all up, after
// which it refuses everyone until it restarts. Reconnecting happens only when
// the connection breaks.
import net from "node:net";

const READ_INPUT_REGISTERS = 0x04;
const CLOSE_GRACE_MS = 3000;

export class ModbusException extends Error {
  code: number;
  constructor(code: number) {
    super(`Modbus exception ${code}`);
    this.code = code;
  }
}

export type ReadRequest = { unit: number; start: number; count: number; timeoutMs?: number };

// Filled in as a request runs, so callers can log where a failure happened.
export type Trace = {
  phase: "connect" | "reply" | "done"; // how far it got
  reused: boolean;                     // sent on an already-open connection
  connectMs: number | null;            // time to TCP connect, when a new connection was opened
  totalMs: number | null;              // time until finished (ok or error)
  localPort: number | null;
  bytes: number;                       // reply bytes received
  connReads: number;                   // reads done on this connection, including this one
  connAgeMs: number | null;            // how long this connection had been open
};

export function newTrace(): Trace {
  return { phase: "connect", reused: false, connectMs: null, totalMs: null, localPort: null, bytes: 0, connReads: 0, connAgeMs: null };
}

// Something worth logging about the connection itself (opened, closed, why).
export type LinkEvent = { kind: "open" | "closed-by-stick" | "dropped" | "closed"; detail: string };

type Pending = {
  transaction: number;
  count: number;
  trace: Trace;
  started: number;
  timer: NodeJS.Timeout;
  resolve: (regs: number[]) => void;
  reject: (err: Error) => void;
};

export class ModbusConnection {
  host: string;
  port: number;
  onEvent: (e: LinkEvent) => void;
  socket: net.Socket | null = null;
  openedAt = 0;
  lastUsed = 0;
  reads = 0;
  transaction = 0;
  buffer = Buffer.alloc(0);
  pending: Pending | null = null;

  constructor(host: string, port: number, onEvent: (e: LinkEvent) => void = () => {}) {
    this.host = host;
    this.port = port;
    this.onEvent = onEvent;
  }

  get connected(): boolean {
    return this.socket !== null;
  }

  async read(req: ReadRequest, trace: Trace = newTrace()): Promise<number[]> {
    if (this.pending) throw new Error("a read is already in progress");
    const started = Date.now();
    const timeoutMs = req.timeoutMs ?? 10_000;
    try {
      if (this.socket) {
        trace.reused = true;
      } else {
        await this.open(timeoutMs);
        trace.connectMs = Date.now() - started;
      }
    } catch (err) {
      trace.totalMs = Date.now() - started;
      throw err;
    }
    trace.phase = "reply";
    trace.localPort = this.socket?.localPort ?? null;
    trace.connAgeMs = started - this.openedAt;
    this.reads++;
    trace.connReads = this.reads;

    const count = Math.min(req.count, 125);
    this.transaction = (this.transaction + 1) & 0xffff;
    const frame = Buffer.alloc(12);
    frame.writeUInt16BE(this.transaction, 0);
    frame.writeUInt16BE(0, 2);
    frame.writeUInt16BE(6, 4);
    frame.writeUInt8(req.unit, 6);
    frame.writeUInt8(READ_INPUT_REGISTERS, 7);
    frame.writeUInt16BE(req.start, 8);
    frame.writeUInt16BE(count, 10);
    this.buffer = Buffer.alloc(0); // anything left over belongs to an older request

    return new Promise<number[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        // A connection that swallows a request is not to be trusted again.
        this.fail(new Error("timed out"), "dropped", "no reply in time");
      }, timeoutMs);
      this.pending = { transaction: this.transaction, count, trace, started, timer, resolve, reject };
      this.socket?.write(frame);
      this.lastUsed = Date.now();
    });
  }

  open(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("timed out"));
      }, timeoutMs);
      socket.once("error", (err) => {
        clearTimeout(timer);
        socket.destroy();
        reject(err);
      });
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.removeAllListeners("error");
        socket.setNoDelay(true);
        // Notices a stick that vanished (e.g. lost power) even between reads.
        socket.setKeepAlive(true, 30_000);
        this.socket = socket;
        this.openedAt = Date.now();
        this.lastUsed = this.openedAt;
        this.reads = 0;
        this.buffer = Buffer.alloc(0);
        // Events from an old socket (e.g. its late FIN after we gave up on it)
        // must not touch the connection that replaced it.
        const current = () => this.socket === socket;
        socket.on("data", (chunk) => current() && this.onData(chunk));
        socket.on("error", (err) => current() && this.fail(err, "dropped", err.message));
        socket.on("end", () => current() && this.fail(new Error("stick closed the connection"), "closed-by-stick", "stick sent FIN"));
        socket.on("close", () => current() && this.fail(new Error("connection closed"), "dropped", "socket closed"));
        this.onEvent({ kind: "open", detail: `local port ${socket.localPort}` });
        resolve();
      });
    });
  }

  onData(chunk: Buffer): void {
    const p = this.pending;
    if (!p) return; // nothing asked for; ignore stray bytes
    this.buffer = Buffer.concat([this.buffer, chunk]);
    p.trace.bytes = this.buffer.length;
    while (this.buffer.length >= 9 && this.buffer.length >= 6 + this.buffer.readUInt16BE(4)) {
      const frameLength = 6 + this.buffer.readUInt16BE(4);
      const frame = this.buffer.subarray(0, frameLength);
      this.buffer = this.buffer.subarray(frameLength);
      if (frame.readUInt16BE(0) !== p.transaction) continue; // late reply to a request we gave up on
      const fn = frame.readUInt8(7);
      if (fn & 0x80) return this.settle(new ModbusException(frame.readUInt8(8)));
      const bytes = frame.readUInt8(8);
      const regs: number[] = [];
      for (let i = 0; i < bytes / 2; i++) regs.push(frame.readUInt16BE(9 + i * 2));
      if (regs.length !== p.count) return this.settle(new Error(`expected ${p.count} registers, got ${regs.length}`));
      return this.settle(null, regs);
    }
  }

  settle(err: Error | null, regs?: number[]): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    p.trace.totalMs = Date.now() - p.started;
    if (err) p.reject(err);
    else {
      p.trace.phase = "done";
      p.resolve(regs ?? []);
    }
  }

  // The connection is broken: forget it (the next read reconnects) and fail any read in progress.
  fail(err: Error, kind: LinkEvent["kind"], detail: string): void {
    const socket = this.socket;
    if (socket) {
      this.socket = null;
      socket.removeAllListeners("data");
      const idle = Math.round((Date.now() - this.lastUsed) / 1000);
      const age = Math.round((Date.now() - this.openedAt) / 1000);
      this.onEvent({ kind, detail: `${detail}; open ${age} s, ${this.reads} reads, idle ${idle} s` });
      this.shut(socket);
    }
    this.settle(err);
  }

  // Close politely (FIN) so the stick can free its slot; force it if the stick doesn't answer.
  shut(socket: net.Socket): Promise<void> {
    return new Promise((resolve) => {
      if (socket.destroyed) return resolve();
      const force = setTimeout(() => {
        socket.destroy();
        resolve();
      }, CLOSE_GRACE_MS);
      socket.once("close", () => {
        clearTimeout(force);
        resolve();
      });
      socket.on("error", () => {}); // errors while closing don't matter
      socket.resume();
      socket.end();
    });
  }

  // Deliberate close, e.g. on shutdown or when the stick changed address.
  async close(reason: string): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    socket.removeAllListeners("data");
    socket.removeAllListeners("end");
    socket.removeAllListeners("close");
    this.onEvent({ kind: "closed", detail: `${reason}; open ${Math.round((Date.now() - this.openedAt) / 1000)} s, ${this.reads} reads` });
    this.settle(new Error(`connection closed: ${reason}`));
    await this.shut(socket);
  }
}
