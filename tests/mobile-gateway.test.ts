import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import type net from "node:net";
import { createMobileGateway } from "../src/mobile/gateway.ts";

test("mobile gateway: one-use pairing, authenticated proxy, private administration and revocation", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "solar-mobile-test-"));
  const upstream = http.createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end('{"solar":true}'); });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as net.AddressInfo).port;
  const gateway = createMobileGateway({ dataDir: dir, upstream: `http://127.0.0.1:${upstreamPort}`,
    lan: "https://192.168.10.10:9443", remote: "https://solar.example:9443", pairing: "http://192.168.10.10:3101",
    adminPort: 3101, tlsPort: 9443, apk: "not-built.apk" });
  await Promise.all([gateway.admin, gateway.secure].map((server) => new Promise<void>((resolve) => server.listen(0,"127.0.0.1",resolve))));
  t.after(async () => {
    for (const server of [gateway.admin,gateway.secure,upstream]) server.closeAllConnections();
    await Promise.all([gateway.admin,gateway.secure,upstream].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    rmSync(dir,{ recursive:true,force:true });
  });
  const adminPort = (gateway.admin.address() as net.AddressInfo).port;
  const securePort = (gateway.secure.address() as net.AddressInfo).port;
  const admin = (path: string, body?: unknown, host="127.0.0.1:3101") => new Promise<{ status: number; body: any }>((resolve,reject) => {
    const req=http.request({ hostname:"127.0.0.1",port:adminPort,path,method:body ? "POST":"GET",headers:{ host,"content-type":"application/json" } },res=>{
      const chunks: Buffer[]=[];res.on("data",c=>chunks.push(c));res.on("end",()=>resolve({status:res.statusCode!,body:JSON.parse(Buffer.concat(chunks).toString())}));
    });req.on("error",reject);req.end(body?JSON.stringify(body):undefined);
  });
  assert.equal((await admin("/api/devices",undefined,"evil.example")).status,403);
  const keyFile=join(dir,"phone.key");
  execFileSync("openssl",["ecparam","-name","prime256v1","-genkey","-noout","-out",keyFile]);
  const csr=execFileSync("openssl",["req","-new","-key",keyFile,"-subj","/CN=test-phone"],{encoding:"utf8"});
  const token=gateway.pki.newPairToken().token;
  const claim=await admin("/api/pair/claim",{ token,csr,name:"Test phone" });
  assert.equal(claim.status,200);
  assert.equal((await admin("/api/pair/claim",{ token,csr,name:"Replay" })).status,403);
  const secure=(path:string,authenticated=true,language="en-US")=>new Promise<{status:number;body:string}>((resolve,reject)=>{
    const req=https.get({ hostname:"127.0.0.1",port:securePort,path,servername:"hub.solar",ca:claim.body.ca,
      ...(authenticated?{key:readFileSync(keyFile),cert:claim.body.cert}:{}),agent:false,headers:{"accept-language":language} },res=>{
      const chunks:Buffer[]=[];res.on("data",c=>chunks.push(c));res.on("end",()=>resolve({status:res.statusCode!,body:Buffer.concat(chunks).toString()}));
    });req.on("error",reject);
  });
  await assert.rejects(secure("/",false));
  assert.deepEqual(await secure("/api/live"),{status:200,body:'{"solar":true}'});
  assert.equal((await secure("/mobile/health")).status,200);
  // Reproduce the real failure mode: the gateway stays up while the reader /
  // dashboard process is unavailable. Pages must not dump the API JSON.
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  const page=await secure("/",true,"pt-BR");
  assert.equal(page.status,502);
  assert.ok(page.body.startsWith("<!doctype html>"));
  assert.ok(page.body.includes("Seu painel está temporariamente indisponível"));
  assert.ok(page.body.includes("<details>"));
  const apiError=await secure("/api/live");
  assert.equal(apiError.status,502);
  assert.deepEqual(JSON.parse(apiError.body),{error:"Dashboard unavailable"});
  assert.equal((await admin(`/api/devices/${claim.body.device.id}/revoke`,{})).body.ok,true);
  await assert.rejects(secure("/api/live"));
});
