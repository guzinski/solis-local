// Minimal Modbus TCP client. It implements only function code 04 (Read Input
// Registers), so nothing in this app can change an inverter setting.
//
// Reuse one connection to limit churn. The cause of the stick's persistent
// refusals is still under investigation; diagnostics distinguish local cleanup
// from peer socket events, including events arriving after a local timeout.
import net from "node:net";
import { randomUUID } from "node:crypto";
import type { Diagnostic } from "./diagnostics.ts";

const READ_INPUT_REGISTERS = 0x04;
const CLOSE_GRACE_MS = 3000;

export class ModbusException extends Error {
  code: number;
  constructor(code: number) {
    super(`Modbus exception ${code}`);
    this.code = code;
  }
}

export type ReadRequest = {
  unit: number; start: number; count: number;
  timeoutMs?: number; replyTimeoutMs?: number;
};

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
  socket: net.Socket;
  transaction: number;
  count: number;
  unit: number;
  trace: Trace;
  started: number;
  timer: NodeJS.Timeout;
  slowTimer: NodeJS.Timeout | null;
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
  busy = false;
  cancelConnect: (() => void) | null = null;
  diagnostics: (d: Diagnostic) => void;
  socketIds = new WeakMap<net.Socket, string>();

  constructor(host: string, port: number, onEvent: (e: LinkEvent) => void = () => {}, diagnostics: (d: Diagnostic) => void = () => {}) {
    this.host = host;
    this.port = port;
    this.onEvent = onEvent;
    this.diagnostics = diagnostics;
  }

  log(event: string, socket: net.Socket | null, fields: Record<string, unknown> = {}): void {
    // Diagnostic storage must never change network behavior on a logging error.
    try {
      this.diagnostics({ event, connection: socket ? this.socketIds.get(socket) : null,
        host: this.host, remotePort: this.port, localAddress: socket?.localAddress,
        localPort: socket?.localPort, bytesWritten: socket?.bytesWritten,
        bytesRead: socket?.bytesRead, ...fields });
    } catch { /* diagnostics are best effort */ }
  }

  get connected(): boolean {
    return this.socket !== null;
  }

  async read(req: ReadRequest, trace: Trace = newTrace()): Promise<number[]> {
    if (this.busy) throw new Error("a read is already in progress");
    this.busy = true;
    try {
      return await this.readRequest(req, trace);
    } finally {
      this.busy = false;
    }
  }

  private async readRequest(req: ReadRequest, trace: Trace): Promise<number[]> {
    if (!Number.isInteger(req.unit) || req.unit < 0 || req.unit > 255 ||
        !Number.isInteger(req.start) || req.start < 0 ||
        !Number.isInteger(req.count) || req.count < 1 || req.count > 125 || req.start + req.count > 65536) {
      throw new Error("invalid Modbus read range or unit");
    }
    const started = Date.now();
    const timeoutMs = req.timeoutMs ?? 10_000;
    const replyTimeoutMs = req.replyTimeoutMs ?? timeoutMs;
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
    const socket = this.socket;
    if (!socket) throw new Error("connection closed before request");
    trace.phase = "reply";
    trace.localPort = socket.localPort ?? null;
    trace.connAgeMs = Date.now() - this.openedAt;
    this.reads++;
    trace.connReads = this.reads;

    const count = req.count;
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
      const transaction = this.transaction;
      const slowTimer = replyTimeoutMs > timeoutMs ? setTimeout(() => {
        this.log("reply-slow", socket, { transaction, bytes: this.pending?.trace.bytes,
          waitedMs: timeoutMs, deadlineMs: replyTimeoutMs, action: "keep connection open; no retry" });
      }, timeoutMs) : null;
      const timer = setTimeout(() => {
        this.log("reply-timeout", socket, { transaction, deadlineMs: replyTimeoutMs,
          bytes: this.pending?.trace.bytes });
        this.fail(new Error("timed out"), "dropped", "no reply in time");
      }, replyTimeoutMs);
      this.pending = { socket, transaction, unit: req.unit, count, trace, started, timer, slowTimer, resolve, reject };
      this.log("request", socket, { transaction, unit: req.unit, start: req.start, count,
        hex: frame.toString("hex"), replyTimeoutMs, reused: trace.reused });
      socket.write(frame, (err) => {
        this.log("write-complete", socket, { transaction, error: err?.message ?? null,
          meaning: "local write callback, not a peer ACK" });
        if (err && this.socket === socket) this.fail(err, "dropped", "write failed");
      });
      this.lastUsed = Date.now();
    });
  }

  open(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port });
      this.socketIds.set(socket, randomUUID());
      this.log("connect-start", socket, { timeoutMs });
      let finished = false;
      const abort = (err: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.cancelConnect = null;
        this.log("connect-failed", socket, { error: err.message, code: (err as NodeJS.ErrnoException).code });
        socket.destroy();
        reject(err);
      };
      const timer = setTimeout(() => abort(new Error("timed out")), timeoutMs);
      this.cancelConnect = () => abort(new Error("connection cancelled during shutdown"));
      // Keep these observers even after the socket is retired. Late FIN, error,
      // close and data events are useful evidence, but must not affect a new socket.
      socket.on("data", (chunk) => {
        this.log("receive", socket, { active: this.socket === socket, length: chunk.length,
          hex: chunk.subarray(0, 4096).toString("hex"), truncated: chunk.length > 4096 });
        if (this.socket === socket) this.onData(chunk);
      });
      socket.on("error", (err) => this.log("socket-error", socket, {
        error: err.message, code: (err as NodeJS.ErrnoException).code }));
      socket.on("end", () => this.log("peer-end", socket));
      socket.on("close", (hadError) => this.log("socket-close", socket, { hadError }));
      socket.once("error", (err) => {
        if (!finished) abort(err);
      });
      socket.once("connect", () => {
        if (finished) return;
        finished = true;
        this.cancelConnect = null;
        clearTimeout(timer);
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
        socket.on("error", (err) => current() && this.fail(err, "dropped", err.message));
        socket.on("end", () => current() && this.fail(new Error("stick closed the connection"), "closed-by-stick", "stick sent FIN"));
        socket.on("close", () => current() && this.fail(new Error("connection closed"), "dropped", "socket closed"));
        this.onEvent({ kind: "open", detail: `local port ${socket.localPort}` });
        this.log("connected", socket, { keepAliveInitialDelayMs: 30_000 });
        resolve();
      });
    });
  }

  onData(chunk: Buffer): void {
    const p = this.pending;
    if (!p) return; // nothing asked for; ignore stray bytes
    this.buffer = Buffer.concat([this.buffer, chunk]);
    p.trace.bytes += chunk.length;
    const invalid = (reason: string) => {
      this.log("invalid-response", this.socket, { transaction: p.transaction, reason });
      this.fail(new Error(`invalid Modbus response: ${reason}`), "dropped", reason);
    };
    while (this.buffer.length >= 7) {
      const length = this.buffer.readUInt16BE(4);
      if (this.buffer.readUInt16BE(2) !== 0 || length < 3 || length > 254) return invalid("MBAP header");
      const frameLength = 6 + length;
      if (this.buffer.length < frameLength) return;
      const frame = this.buffer.subarray(0, frameLength);
      this.buffer = this.buffer.subarray(frameLength);
      if (frame.readUInt16BE(0) !== p.transaction) {
        this.log("unmatched-response", this.socket, { transaction: frame.readUInt16BE(0), expected: p.transaction });
        continue;
      }
      if (frame[6] !== p.unit) return invalid("unit mismatch");
      const fn = frame.readUInt8(7);
      if (fn === (READ_INPUT_REGISTERS | 0x80)) {
        if (length !== 3) return invalid("exception length");
        return this.settle(new ModbusException(frame.readUInt8(8)));
      }
      if (fn !== READ_INPUT_REGISTERS) return invalid("function mismatch");
      const bytes = frame.readUInt8(8);
      if (bytes !== p.count * 2 || length !== 3 + bytes) return invalid("register byte count or frame length");
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
    if (p.slowTimer) clearTimeout(p.slowTimer);
    p.trace.totalMs = Date.now() - p.started;
    this.log("request-settled", p.socket, { transaction: p.transaction,
      totalMs: p.trace.totalMs, bytes: p.trace.bytes, error: err?.message ?? null });
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
        this.log("local-destroy", socket, { reason: "close grace expired", graceMs: CLOSE_GRACE_MS });
        socket.destroy();
        resolve();
      }, CLOSE_GRACE_MS);
      socket.once("close", () => {
        clearTimeout(force);
        resolve();
      });
      socket.on("error", () => {}); // errors while closing don't matter
      socket.resume();
      this.log("local-end", socket, { graceMs: CLOSE_GRACE_MS });
      socket.end();
    });
  }

  // Deliberate close, e.g. on shutdown or when the stick changed address.
  async close(reason: string): Promise<void> {
    this.cancelConnect?.();
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    this.log("close-requested", socket, { reason });
    this.onEvent({ kind: "closed", detail: `${reason}; open ${Math.round((Date.now() - this.openedAt) / 1000)} s, ${this.reads} reads` });
    this.settle(new Error(`connection closed: ${reason}`));
    await this.shut(socket);
  }
}
