import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";
import { test, type TestContext } from "node:test";
import { ModbusConnection, newTrace } from "../src/modbus.ts";
import type { Diagnostic } from "../src/diagnostics.ts";

class Socket extends EventEmitter {
  destroyed = false;
  localPort = 12345;
  localAddress = "127.0.0.1";
  writes: Buffer[] = [];
  ends = 0;
  closeOnEnd = true;
  bytesRead = 0;
  bytesWritten = 0;
  setNoDelay() {} setKeepAlive() {} resume() {}
  write(frame: Buffer, callback: (err?: Error) => void) {
    this.writes.push(Buffer.from(frame));
    this.bytesWritten += frame.length;
    callback();
  }
  end() { this.ends++; if (this.closeOnEnd) this.destroy(); }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit("close", false); } }
}
const req = { unit: 1, start: 2999, count: 46, timeoutMs: 10, replyTimeoutMs: 200 };
function response(transaction = 1): Buffer {
  const frame = Buffer.alloc(101);
  frame.writeUInt16BE(transaction, 0); frame.writeUInt16BE(95, 4);
  frame[6] = 1; frame[7] = 4; frame[8] = 92;
  return frame;
}
async function fixture(t: TestContext) {
  const sockets: Socket[] = [];
  const events: Diagnostic[] = [];
  t.mock.method(net, "connect", () => { const socket = new Socket(); sockets.push(socket); return socket; });
  const conn = new ModbusConnection("test.invalid", 502, () => {}, (d) => events.push(d));
  t.after(async () => { await conn.close("test cleanup"); t.mock.restoreAll(); });
  const connect = async () => { sockets.at(-1)!.emit("connect"); await Promise.resolve(); };
  return { sockets, events, conn, connect };
}

test("late fragmented reply succeeds on the original socket, with no retry or early close", async (t) => {
  const { sockets, events, conn, connect } = await fixture(t);
  const trace = newTrace();
  const read = conn.read(req, trace);
  await connect();
  assert.equal(sockets[0].writes[0].toString("hex"), "00010000000601040bb7002e");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(events.filter((e) => e.event === "reply-slow").length, 1);
  assert.equal(sockets[0].ends, 0);
  assert.equal(sockets[0].writes.length, 1);
  sockets[0].emit("data", response().subarray(0, 8));
  sockets[0].emit("data", response().subarray(8));
  assert.equal((await read).length, 46);
  assert.equal(trace.bytes, 101);
  assert.equal(events.some((e) => e.event === "reply-timeout"), false);
  const second = conn.read(req); await Promise.resolve();
  sockets[0].emit("data", response(2)); await second;
  assert.equal(sockets.length, 1);
  const request = events.find((e) => e.event === "request")!;
  assert.ok(request.connection);
  assert.equal(events.find((e) => e.event === "request-settled")!.connection, request.connection);
});

test("deadline logs timeout before local cleanup and preserves later peer events", async (t) => {
  const { sockets, events, conn, connect } = await fixture(t);
  const read = assert.rejects(conn.read({ ...req, replyTimeoutMs: 25 }), /timed out/);
  await connect(); await read;
  assert.equal(sockets[0].writes.length, 1);
  assert.equal(sockets[0].ends, 1);
  assert.ok(events.findIndex((e) => e.event === "reply-timeout") < events.findIndex((e) => e.event === "local-end"));
  sockets[0].emit("end");
  assert.ok(events.find((e) => e.event === "peer-end"));
  assert.ok(events.find((e) => e.event === "request-settled")!.connection);
});

test("peer FIN is recorded without a reply timeout", async (t) => {
  const { sockets, events, conn, connect } = await fixture(t);
  const read = assert.rejects(conn.read(req), /stick closed/);
  await connect(); sockets[0].emit("end"); await read;
  assert.ok(events.findIndex((e) => e.event === "peer-end") < events.findIndex((e) => e.event === "local-end"));
  assert.equal(events.some((e) => e.event === "reply-timeout"), false);
});

test("concurrent reads cannot open duplicate connecting sockets", async (t) => {
  const { sockets, conn } = await fixture(t);
  const first = assert.rejects(conn.read(req), /cancelled/);
  await assert.rejects(conn.read(req), /already in progress/);
  assert.equal(sockets.length, 1);
  await conn.close("shutdown"); await first;
  sockets[0].emit("connect"); await Promise.resolve();
  assert.equal(conn.connected, false);
  assert.equal(sockets[0].writes.length, 0);
});

test("malformed reply is logged and rejected instead of throwing from the data event", async (t) => {
  const { sockets, events, conn, connect } = await fixture(t);
  const read = assert.rejects(conn.read(req), /invalid Modbus response/);
  await connect();
  assert.doesNotThrow(() => sockets[0].emit("data", Buffer.from("00010000000301045c", "hex")));
  await read;
  assert.ok(events.find((e) => e.event === "invalid-response"));
});

test("unacknowledged local close is force-destroyed and logged after its grace period", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sockets, events, conn, connect } = await fixture(t);
  const read = conn.read(req); await connect();
  sockets[0].emit("data", response()); await read;
  sockets[0].closeOnEnd = false;
  const closing = conn.close("test shutdown");
  assert.equal(sockets[0].destroyed, false);
  t.mock.timers.tick(3000);
  await closing;
  assert.equal(sockets[0].destroyed, true);
  assert.ok(events.find((e) => e.event === "local-destroy"));
});
