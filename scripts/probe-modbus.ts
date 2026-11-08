// Read-only Modbus TCP probe. It can only send function code 04 (Read Input
// Registers); there is no write code in this file, so it cannot change any
// inverter setting.
//
//   node scripts/probe-modbus.ts <stick-ip> [start=33000] [count=60] [unit=1]
import net from "node:net";

const [host, startArg = "33000", countArg = "60", unitArg = "1"] = process.argv.slice(2);
if (!host) {
  console.error("usage: node scripts/probe-modbus.ts <stick-ip> [start] [count] [unit]");
  process.exit(2);
}
const start = Number(startArg), count = Math.min(Number(countArg), 125), unit = Number(unitArg);

const READ_INPUT_REGISTERS = 0x04;
const request = Buffer.alloc(12);
request.writeUInt16BE(1, 0);        // transaction id
request.writeUInt16BE(0, 2);        // protocol id (Modbus)
request.writeUInt16BE(6, 4);        // bytes that follow
request.writeUInt8(unit, 6);
request.writeUInt8(READ_INPUT_REGISTERS, 7);
request.writeUInt16BE(start, 8);
request.writeUInt16BE(count, 10);

const socket = net.connect({ host, port: 502 });
socket.setTimeout(8000);
let reply = Buffer.alloc(0);
socket.on("connect", () => socket.write(request));
socket.on("data", (chunk) => {
  reply = Buffer.concat([reply, chunk]);
  if (reply.length >= 9 && reply.length >= 6 + reply.readUInt16BE(4)) {
    socket.end();
    report(reply);
  }
});
socket.on("timeout", () => { console.error("timed out waiting for a reply"); socket.destroy(); process.exit(1); });
socket.on("error", (err) => { console.error(`connection error: ${err.message}`); process.exit(1); });

function report(frame: Buffer) {
  const fn = frame.readUInt8(7);
  if (fn & 0x80) {
    console.error(`Modbus exception ${frame.readUInt8(8)} (1=illegal function, 2=illegal address, 4=device failure, 11=no response from inverter)`);
    process.exit(1);
  }
  const bytes = frame.readUInt8(8);
  const regs: number[] = [];
  for (let i = 0; i < bytes / 2; i++) regs.push(frame.readUInt16BE(9 + i * 2));
  console.log(`unit ${unit}, registers ${start}..${start + regs.length - 1}:`);
  for (let i = 0; i < regs.length; i += 8) {
    console.log(`  ${String(start + i).padEnd(6)} ${regs.slice(i, i + 8).map((v) => String(v).padStart(6)).join(" ")}`);
  }
}
