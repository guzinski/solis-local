// Passive packet capture: no probes and no Modbus requests. Run in a terminal
// on the same machine/network namespace as the monitor, before restarting it.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { userInfo } from "node:os";
import { readConfig } from "../src/env.ts";
import { terminalWriter } from "../src/terminal-output.ts";

const output = terminalWriter(process.stdout);
const errors = terminalWriter(process.stderr);
const log = (message: string) => output(message + "\n");
const error = (message: string) => errors(message + "\n");

const config = readConfig();
const withMonitor = process.argv.includes("--monitor");
const directory = resolve("data/captures", new Date().toISOString().replace(/[:.]/g, "-"));
// Filter by port rather than host so DHCP relocation doesn't silently end the
// evidence. This records only traffic visible here, not other LAN clients.
const args = ["-i", "any", "-p", "-nn", "-s", "0", "-U", "-C", "8", "-W", "8",
  "-Z", userInfo().username, "-w", `${directory}/modbus.pcap`, "tcp", "port", String(config.stickPort)];
if (process.argv.includes("--dry-run")) {
  log(JSON.stringify({ command: "sudo", args: ["tcpdump", ...args], directory,
    maxCaptureBytes: 64_000_000, filter: `tcp port ${config.stickPort}`,
    startMonitorAfterCaptureReady: withMonitor }, null, 2));
  process.exit(0);
}
const version = spawnSync("tcpdump", ["--version"], { encoding: "utf8" });
if (version.error || version.status !== 0) {
  error("tcpdump is required. Install it with: sudo apt-get install tcpdump");
  process.exit(1);
}
mkdirSync(directory, { recursive: true, mode: 0o700 });
writeFileSync(`${directory}/capture.json`, JSON.stringify({ started: new Date().toISOString(),
  port: config.stickPort, args, version: version.stdout.trim(),
  note: "Passive capture. Application write-complete events are not TCP acknowledgments." }, null, 2), { mode: 0o600 });
log(`Capture directory: ${directory}`);
log("Eight rotating 8 MB files. Wait for tcpdump's 'listening on' message before restarting the monitor.");
log("After a failure, allow the 120s reply deadline plus at least 30s for cleanup, then Ctrl+C to preserve the files.");
const child = spawn("sudo", ["tcpdump", ...args], { stdio: ["inherit", "inherit", "pipe"], env: { ...process.env, LC_ALL: "C" } });
let monitor: ChildProcess | null = null;
let captureReady = false;
let captureDone = false;
let interrupted = false;
let stderr = "";
child.stderr!.on("data", (chunk: Buffer) => {
  errors(chunk);
  stderr = (stderr + chunk.toString()).slice(-8000);
  if (!captureReady && /listening on /.test(stderr)) {
    captureReady = true;
    if (withMonitor) {
      log("Packet capture ready. Starting one monitor with the 120s timeout experiment.");
      monitor = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "src/server.ts"], {
        stdio: ["inherit", "pipe", "pipe"], env: { ...process.env, MODBUS_REPLY_TIMEOUT_SECONDS: "120",
          MODBUS_TRACE_PATH: config.diagnosticPath ?? "data/diagnostics/modbus.jsonl" },
      });
      monitor.stdout!.on("data", output);
      monitor.stderr!.on("data", errors);
      monitor.on("error", (err) => { error(err.message); process.exitCode = 1; child.kill("SIGTERM"); });
      monitor.on("exit", (code) => {
        if (code) process.exitCode = code;
        if (!captureDone) child.kill("SIGTERM");
      });
    }
  }
});
// Ctrl+C reaches sudo/tcpdump in the terminal process group. Keep the launcher
// alive until the child has flushed its capture and printed packet-drop counts.
process.on("SIGINT", () => { interrupted = true; });
process.on("SIGTERM", () => { interrupted = true; monitor?.kill("SIGTERM"); child.kill("SIGTERM"); });
child.on("error", (err) => { error(err.message); process.exitCode = 1; });
child.on("exit", (code, signal) => {
  captureDone = true;
  if (!interrupted) monitor?.kill("SIGTERM");
  if (!captureReady && withMonitor) error("Capture did not start; the monitor was not launched.");
  if (!interrupted && (!captureReady || code || signal)) process.exitCode = code || 1;
});
