// Record which devices are on the LAN, then compare later to spot new ones.
// Runs through Windows (powershell.exe) because WSL can't see the LAN's ARP table.
// It only pings; results go to data/, which is gitignored because they hold real
// IPs and MACs.
//
//   node scripts/lan-snapshot.ts <a.b.c> baseline    save the reference list
//   node scripts/lan-snapshot.ts <a.b.c> compare     show what's new since then
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const BASELINE = "data/lan-baseline.json";
const PASSES = 3;

type Devices = Record<string, string>; // MAC -> IP

const [prefix, mode] = process.argv.slice(2);
if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(prefix ?? "") || !["baseline", "compare"].includes(mode ?? "")) {
  console.error("usage: node scripts/lan-snapshot.ts <a.b.c> baseline|compare");
  process.exit(2);
}

function sweep(): Devices {
  const command = `
    $p = 1..254 | ForEach-Object { (New-Object System.Net.NetworkInformation.Ping).SendPingAsync("${prefix}.$_", 1000) }
    try { [void][Threading.Tasks.Task]::WaitAll($p) } catch {}
    arp -a`;
  const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
    timeout: 30_000,
  });
  const devices: Devices = {};
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f-]{17})\s/i.exec(line);
    if (!match || !match[1].startsWith(`${prefix}.`) || match[1].endsWith(".255")) continue;
    if (match[2].toLowerCase() !== "ff-ff-ff-ff-ff-ff") devices[match[2].toLowerCase()] = match[1];
  }
  return devices;
}

// Phones and laptops randomise their MAC; a datalogger stick has a fixed one.
const isRandomised = (mac: string) => "26ae".includes(mac[1]);

const seen: Devices = {};
for (let pass = 0; pass < PASSES; pass++) Object.assign(seen, sweep());

const byIp = (a: [string, string], b: [string, string]) =>
  Number(a[1].split(".")[3]) - Number(b[1].split(".")[3]);
const show = ([mac, ip]: [string, string]) => `  ${ip.padEnd(16)} ${mac}${isRandomised(mac) ? "  (randomised MAC)" : ""}`;

if (mode === "baseline") {
  mkdirSync("data", { recursive: true });
  writeFileSync(BASELINE, JSON.stringify({ takenAt: new Date().toISOString(), devices: seen }, null, 2) + "\n");
  console.log(`Saved ${Object.keys(seen).length} devices to ${BASELINE}:`);
  console.log(Object.entries(seen).sort(byIp).map(show).join("\n"));
} else {
  if (!existsSync(BASELINE)) {
    console.error(`No ${BASELINE} yet; run with "baseline" first.`);
    process.exit(1);
  }
  const { takenAt, devices } = JSON.parse(readFileSync(BASELINE, "utf8")) as { takenAt: string; devices: Devices };
  const fresh = Object.entries(seen).filter(([mac]) => !(mac in devices)).sort(byIp);
  const fixed = fresh.filter(([mac]) => !isRandomised(mac));
  const random = fresh.filter(([mac]) => isRandomised(mac));
  console.log(`Compared with baseline from ${takenAt}.`);
  console.log(`\nNew devices with a fixed MAC (possible stick): ${fixed.length}`);
  if (fixed.length) console.log(fixed.map(show).join("\n"));
  console.log(`\nNew devices with a randomised MAC (almost certainly phones or laptops): ${random.length}`);
  if (random.length) console.log(random.map(show).join("\n"));
}
