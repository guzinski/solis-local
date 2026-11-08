// Minimal Modbus TCP client. It implements only function code 04 (Read Input
// Registers), so nothing in this app can change an inverter setting.
import net from "node:net";

const READ_INPUT_REGISTERS = 0x04;
let transaction = 0;

export class ModbusException extends Error {
  code: number;
  constructor(code: number) {
    super(`Modbus exception ${code}`);
    this.code = code;
  }
}

export type ReadRequest = {
  host: string;
  port: number;
  unit: number;
  start: number;
  count: number;
  timeoutMs?: number;
};

export function readInputRegisters(req: ReadRequest): Promise<number[]> {
  const count = Math.min(req.count, 125);
  transaction = (transaction + 1) & 0xffff;
  const frame = Buffer.alloc(12);
  frame.writeUInt16BE(transaction, 0);
  frame.writeUInt16BE(0, 2);
  frame.writeUInt16BE(6, 4);
  frame.writeUInt8(req.unit, 6);
  frame.writeUInt8(READ_INPUT_REGISTERS, 7);
  frame.writeUInt16BE(req.start, 8);
  frame.writeUInt16BE(count, 10);

  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: req.host, port: req.port });
    let reply = Buffer.alloc(0);
    let settled = false;
    const finish = (err: Error | null, regs?: number[]) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(regs ?? []);
    };
    socket.setTimeout(req.timeoutMs ?? 5000);
    socket.once("connect", () => socket.write(frame));
    socket.once("timeout", () => finish(new Error("timed out")));
    socket.once("error", (err) => finish(err));
    socket.once("close", () => finish(new Error("connection closed before a reply")));
    socket.on("data", (chunk) => {
      reply = Buffer.concat([reply, chunk]);
      if (reply.length < 9 || reply.length < 6 + reply.readUInt16BE(4)) return;
      if (reply.readUInt16BE(0) !== transaction) return finish(new Error("reply for another request"));
      const fn = reply.readUInt8(7);
      if (fn & 0x80) return finish(new ModbusException(reply.readUInt8(8)));
      const bytes = reply.readUInt8(8);
      const regs: number[] = [];
      for (let i = 0; i < bytes / 2; i++) regs.push(reply.readUInt16BE(9 + i * 2));
      if (regs.length !== count) return finish(new Error(`expected ${count} registers, got ${regs.length}`));
      finish(null, regs);
    });
  });
}
