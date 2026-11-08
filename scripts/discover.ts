// Find a datalogger stick on the LAN. Read-only: it opens a TCP connection to
// each port and closes it, and only sends a plain HTTP GET to web ports. It
// never speaks Modbus or Solarman, so it cannot change anything on the inverter.
//
//   node scripts/discover.ts 192.168.x        (first three octets of your LAN)
import net from "node:net";

const PORTS = [80, 8080, 8899, 502, 6607];
const TIMEOUT_MS = 1200;
const CONCURRENCY = 48;

const prefix = process.argv[2]?.replace(/\.$/, "");
if (!prefix || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(prefix)) {
  console.error("usage: node scripts/discover.ts <a.b.c>   (e.g. the first three octets of your LAN)");
  process.exit(2);
}

function isOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(TIMEOUT_MS);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function httpBanner(host: string, port: number): Promise<string> {
  try {
    const res = await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(2500), redirect: "manual" });
    const body = (await res.text()).slice(0, 4000);
    const title = /<title>([^<]*)<\/title>/i.exec(body)?.[1]?.trim();
    return [
      res.status,
      res.headers.get("server") ?? "",
      res.headers.get("www-authenticate") ?? "",
      title ? `title="${title}"` : "",
    ].filter(Boolean).join(" | ");
  } catch (err) {
    return `no HTTP answer (${(err as Error).name})`;
  }
}

const jobs: Array<[string, number]> = [];
for (let i = 1; i < 255; i++) for (const port of PORTS) jobs.push([`${prefix}.${i}`, port]);

const found = new Map<string, number[]>();
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let job = jobs.shift(); job; job = jobs.shift()) {
      const [host, port] = job;
      if (await isOpen(host, port)) found.set(host, [...(found.get(host) ?? []), port]);
    }
  }),
);

const hosts = [...found.keys()].sort((a, b) => Number(a.split(".")[3]) - Number(b.split(".")[3]));
for (const host of hosts) {
  const ports = (found.get(host) ?? []).sort((a, b) => a - b);
  console.log(`${host}  open: ${ports.join(", ")}`);
  for (const port of ports.filter((p) => p === 80 || p === 8080)) {
    console.log(`    :${port}  ${await httpBanner(host, port)}`);
  }
}
console.log(`\n${hosts.length} host(s) with a port open; ${hosts.filter((h) => found.get(h)?.includes(8899)).length} with 8899, ${hosts.filter((h) => found.get(h)?.includes(502)).length} with 502.`);
