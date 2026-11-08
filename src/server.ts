// HTTP server: a read-only JSON API plus the static dashboard in public/.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { readConfig } from "./env.ts";
import { Poller } from "./poller.ts";
import { Store } from "./store.ts";
import { dayKey } from "./time.ts";

const config = readConfig();
const store = new Store(config.dbPath);
const poller = new Poller(config, store);
const PUBLIC = resolve("public");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function live() {
  const reading = store.latest();
  const now = Date.now();
  const today = dayKey(now);
  // Totals for "today" only count if the last reading was taken today.
  const fresh = reading !== null && dayKey(reading.ts) === today;
  return {
    plantName: config.plantName,
    plantKwp: config.plantKwp,
    pollSeconds: config.pollSeconds,
    alertMinutes: config.alertMinutes,
    now,
    link: poller.state,
    reading,
    todayKwh: fresh ? reading.todayKwh : 0,
  };
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://local");
  if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "read-only" });

  if (url.pathname === "/api/live") return json(res, 200, live());
  if (url.pathname === "/api/day") {
    const day = url.searchParams.get("date") ?? dayKey(Date.now());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json(res, 400, { error: "date must be YYYY-MM-DD" });
    const kwh = store.totals("days", day).find((t) => t.key === day)?.kwh ?? null;
    return json(res, 200, { date: day, kwh, points: store.dayCurve(day) });
  }
  if (url.pathname === "/api/totals") {
    return json(res, 200, { days: store.totals("days"), months: store.totals("months"), years: store.totals("years") });
  }
  if (url.pathname.startsWith("/api/")) return json(res, 404, { error: "not found" });

  const path = normalize(join(PUBLIC, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname)));
  if (!path.startsWith(PUBLIC + "/") || !existsSync(path) || !statSync(path).isFile()) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("not found");
  }
  res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream", "cache-control": "no-cache" });
  createReadStream(path).pipe(res);
});

server.listen(config.httpPort, config.httpHost, () => {
  console.log(`dashboard on http://${config.httpHost}:${config.httpPort}  (polling every ${config.pollSeconds}s)`);
  poller.start();
});
