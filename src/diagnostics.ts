// Bounded, private application trace. TCP ACK/FIN/RST evidence comes from the
// separate packet capture; a successful socket.write callback is not a peer ACK.
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type Diagnostic = { event: string; [key: string]: unknown };

export class DiagnosticLog {
  readonly run = randomUUID();
  readonly started = process.hrtime.bigint();
  warned = false;
  path: string;
  maxBytes: number;
  backups: number;

  constructor(path: string, maxBytes = 4_000_000, backups = 3) {
    this.path = path;
    this.maxBytes = maxBytes;
    this.backups = backups;
  }

  write(data: Diagnostic): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const line = JSON.stringify({ ...data, ts: new Date().toISOString(),
        elapsedMs: Number(process.hrtime.bigint() - this.started) / 1e6,
        pid: process.pid, run: this.run }) + "\n";
      if (existsSync(this.path) && statSync(this.path).size + Buffer.byteLength(line) > this.maxBytes) {
        const last = `${this.path}.${this.backups}`;
        if (existsSync(last)) unlinkSync(last);
        for (let n = this.backups - 1; n >= 1; n--) {
          if (existsSync(`${this.path}.${n}`)) renameSync(`${this.path}.${n}`, `${this.path}.${n + 1}`);
        }
        renameSync(this.path, `${this.path}.1`);
      }
      appendFileSync(this.path, line, { mode: 0o600 });
    } catch (err) {
      if (!this.warned) console.error(`Modbus diagnostic log unavailable: ${(err as Error).message}`);
      this.warned = true;
    }
  }
}
