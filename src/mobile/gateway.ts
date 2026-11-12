// Independent companion: reads the existing dashboard over HTTP. Never polls
// Modbus, opens the database, or restarts the monitor.
import http from "node:http";
import https from "node:https";
import type tls from "node:tls";
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createPki, PairError } from "./pki.ts";

type Options = { dataDir: string; upstream: string; lan: string; remote: string;
  pairing: string; adminPort: number; tlsPort: number; apk: string };
const loopback = (ip: string) => ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
const privateIp = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) &&
  ip.split(".").length === 4 && ip.split(".").every((s) => /^\d{1,3}$/.test(s) && Number(s) <= 255);

export function createMobileGateway(options: Options) {
  const upstream = new URL(options.upstream);
  if (upstream.protocol !== "http:" || !loopback(upstream.hostname) || upstream.username || upstream.password)
    throw new Error("Mobile upstream must be a loopback HTTP address");
  for (const value of [options.lan, options.remote]) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.username || url.password || url.search || url.hash)
      throw new Error("Mobile dashboard addresses must be HTTPS origins");
  }
  const pairing = new URL(options.pairing);
  if (pairing.protocol !== "http:" || !privateIp(pairing.hostname) || pairing.pathname !== "/" || pairing.username || pairing.password || pairing.search || pairing.hash)
    throw new Error("Pairing address must be a private LAN IPv4 HTTP origin");
  const pki = createPki(options.dataDir);
  pki.ensurePki();
  const json = (res: http.ServerResponse, code: number, value: unknown) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(value));
  };
  const readBody = async (req: http.IncomingMessage) => {
    if (!req.headers["content-type"]?.startsWith("application/json")) throw new PairError(415, "JSON required");
    let size = 0; const chunks: Buffer[] = [];
    for await (const c of req) { size += c.length; if (size > 16_384) throw new PairError(413, "Request too large"); chunks.push(c); }
    try { return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>; }
    catch { throw new PairError(400, "Invalid JSON"); }
  };
  const clients = new Map<string, Set<tls.TLSSocket>>();
  pki.onRevoke((fp) => { for (const socket of clients.get(fp) ?? []) socket.destroy(); });
  const secure = https.createServer({ ...pki.tlsMaterial(), requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.2" }, (req, res) => {
    const fp = (req.socket as tls.TLSSocket).getPeerX509Certificate()?.fingerprint256;
    if (!fp || !pki.isActiveDevice(fp)) return json(res, 403, { error: "Device revoked" });
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "Read only" });
    if (req.url === "/mobile/health") return json(res, 200, { ok: true });
    if (!req.url?.startsWith("/") || req.url.startsWith("//")) return json(res, 400, { error: "Invalid path" });
    // A fixed loopback destination prevents the public listener becoming a proxy.
    const proxy = http.request({ hostname: upstream.hostname, port: upstream.port || 80,
      path: req.url, method: req.method, timeout: 10_000, headers: { host: upstream.host } }, (reply) => {
      res.writeHead(reply.statusCode ?? 502, { ...reply.headers, "cache-control": "no-store" });
      reply.pipe(res);
    });
    proxy.on("timeout", () => proxy.destroy(new Error("Dashboard timeout")));
    proxy.on("error", () => { if (!res.headersSent) json(res, 502, { error: "Dashboard unavailable" }); else res.destroy(); });
    res.on("close", () => proxy.destroy());
    proxy.end();
  });
  secure.on("secureConnection", (socket: tls.TLSSocket) => {
    const fp = socket.getPeerX509Certificate()?.fingerprint256;
    if (!fp || !pki.isActiveDevice(fp)) { socket.destroy(); return; }
    const set = clients.get(fp) ?? new Set<tls.TLSSocket>(); set.add(socket); clients.set(fp, set);
    socket.on("close", () => { set.delete(socket); if (!set.size) clients.delete(fp); });
  });
  secure.on("tlsClientError", () => {});
  // Failed remote claims are bounded per client; tokens are one use and expire.
  const claims = new Map<string, { count: number; until: number }>();
  const admin = http.createServer(async (req, res) => {
    const path = req.url?.split("?")[0];
    const local = loopback(req.socket.remoteAddress ?? "");
    try {
      if (path === "/app.apk" && req.method === "GET") {
        const apk = resolve(options.apk);
        if (!existsSync(apk)) return json(res, 404, { error: "Build the Android app first" });
        res.writeHead(200, { "content-type": "application/vnd.android.package-archive", "content-disposition": 'attachment; filename="solar-monitor.apk"', "cache-control": "no-store" });
        createReadStream(apk).pipe(res); return;
      }
      if (path === "/api/pair/claim" && req.method === "POST") {
        const ip = req.socket.remoteAddress ?? "";
        const previous = claims.get(ip);
        const limit = previous && previous.until > Date.now() ? previous : { count: 0, until: Date.now() + 60_000 };
        if (++limit.count > 5) throw new PairError(429, "Wait a minute before trying again");
        if (claims.size > 256) claims.clear(); claims.set(ip, limit);
        const body = await readBody(req);
        if (!body || typeof body !== "object") throw new PairError(400, "Invalid request");
        const result = pki.claimPairing(String(body.token ?? ""), String(body.name ?? ""), String(body.csr ?? ""));
        json(res, 200, { ...result, lanSecure: options.lan, remote: options.remote }); return;
      }
      // Bootstrap/admin actions are available only on this computer, with a
      // loopback Host and same-origin JSON POSTs (prevents LAN access and rebinding).
      const host = req.headers.host;
      const origins = [`http://127.0.0.1:${options.adminPort}`, `http://localhost:${options.adminPort}`];
      if (!local || !origins.some((o) => new URL(o).host === host) ||
          (req.headers.origin && !origins.includes(req.headers.origin))) return json(res, 403, { error: "Open setup on the home computer" });
      if (path === "/i18n.js" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
        createReadStream(resolve("public/i18n.js")).pipe(res); return;
      }
      if (path === "/" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
          "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'", "x-frame-options": "DENY" });
        res.end(SETUP_HTML); return;
      }
      if (path === "/api/pair/start" && req.method === "POST") {
        await readBody(req);
        const { token, expires } = pki.newPairToken();
        const query = new URLSearchParams({ v: "1", t: token, lan: options.pairing, ca: pki.caFingerprint() });
        // Addresses come from the trusted QR, never from an unsigned claim response.
        query.set("secure", options.lan); query.set("remote", options.remote);
        const uri = `solar://pair?${query}`;
        const qr = execFileSync("qrencode", ["-t", "SVG", "-m", "2", "-o", "-"], { input: uri, encoding: "utf8" });
        json(res, 200, { qr, expires }); return;
      }
      if (path === "/api/devices" && req.method === "GET") { json(res, 200, pki.loadDevices()); return; }
      const revoke = /^\/api\/devices\/([a-f0-9]{12})\/revoke$/.exec(path ?? "");
      if (revoke && req.method === "POST") { await readBody(req); json(res, 200, { ok: pki.revokeDevice(revoke[1]) }); return; }
      json(res, 404, { error: "Not found" });
    } catch (e) { json(res, e instanceof PairError ? e.status : 500, { error: e instanceof PairError ? e.message : "Request failed" }); }
  });
  admin.requestTimeout = 20_000;
  return { secure, admin, pki };
}

const SETUP_HTML = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Solar Monitor</title>
<style>body{font:17px system-ui;background:#f9f9f7;color:#25251f;max-width:620px;margin:60px auto;padding:24px}button{font:inherit;padding:12px 18px;border:0;border-radius:10px;background:#d38a00;color:white;cursor:pointer}#qr svg{width:320px;max-width:100%;height:auto}li{margin:16px 0}li button{margin-left:16px;font-size:14px}#status{color:#666}</style>
<h1 data-i18n="setupTitle">Solar Monitor</h1><p data-i18n="setupIntro"></p>
<button id="pair" data-i18n="generateCode">Generate linking code</button><p id="status"></p><div id="qr"></div><h2 data-i18n="linkedPhones">Linked phones</h2><ul id="devices"></ul>
<script type="module">import {locale,t} from './i18n.js';document.documentElement.lang=locale;for(const e of document.querySelectorAll('[data-i18n]'))e.textContent=t(e.dataset.i18n);const api=async(path,body)=>{const r=await fetch(path,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});const d=await r.json();if(!r.ok)throw Error(d.error);return d};
document.querySelector('#pair').onclick=async()=>{try{const d=await api('/api/pair/start',{});document.querySelector('#qr').innerHTML=d.qr;document.querySelector('#status').textContent=t('codeExpires')}catch(e){document.querySelector('#status').textContent=t('setupError')}};
async function devices(){try{const ds=await api('/api/devices');const list=document.querySelector('#devices');list.replaceChildren();for(const d of ds){const li=document.createElement('li');li.textContent=d.name+(d.revoked?t('revoked'):'');if(!d.revoked){const b=document.createElement('button');b.textContent=t('revoke');b.onclick=async()=>{if(confirm(t('revokeConfirm'))){await api('/api/devices/'+d.id+'/revoke',{});devices()}};li.append(b)}list.append(li)}}catch(e){document.querySelector('#status').textContent=t('setupError')}}devices();setInterval(devices,5000);</script></html>`;
