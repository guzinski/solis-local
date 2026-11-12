// Independent Solar device certificates; adapted from the local ONVIF implementation.
import { execFileSync } from "node:child_process";
import { X509Certificate, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


export function createPki(dataDir: string) {
const PKI_DIR = join(dataDir, "pki");
const CA_KEY = join(PKI_DIR, "ca.key");
const CA_CRT = join(PKI_DIR, "ca.crt");
const SRV_KEY = join(PKI_DIR, "server.key");
const SRV_CRT = join(PKI_DIR, "server.crt");
const DEVICES = join(PKI_DIR, "devices.json");

/** The app checks for this name in the server certificate instead of an IP
 *  or domain, so the hub can be reached at any address (LAN, VPS). Client
 *  certificates never carry it, so a phone's certificate can't pose as the hub. */
const SERVER_NAME = "hub.solar";
const TEN_YEARS = "3650";

interface Device {
  id: string;
  name: string;
  /** SHA-256 fingerprint of the client certificate, "AB:CD:..." as Node prints it. */
  fingerprint256: string;
  created: string;
  revoked?: string;
}

function openssl(args: string[], input?: string): string {
  return execFileSync("openssl", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

/** Create the CA and the hub's server certificate on first use. */
function ensurePki(): void {
  mkdirSync(PKI_DIR, { recursive: true, mode: 0o700 });
  if (!existsSync(CA_KEY) || !existsSync(CA_CRT)) {
    if (existsSync(CA_KEY) || existsSync(CA_CRT)) throw new Error("Incomplete Solar CA files; restore the existing identity before starting");
    console.log("[pki] creating independent Solar certificate authority");
    openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", CA_KEY]);
    openssl([
      "req", "-x509", "-new", "-key", CA_KEY, "-out", CA_CRT, "-days", TEN_YEARS, "-sha256",
      "-subj", "/CN=Solar Monitor Hub CA",
      "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    ]);
    rmSync(SRV_CRT, { force: true }); // a new CA invalidates the old server cert
  }
  if (!existsSync(SRV_KEY) || !existsSync(SRV_CRT)) {
    openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", SRV_KEY]);
    const csr = openssl(["req", "-new", "-key", SRV_KEY, "-subj", "/CN=Solar Monitor Hub"]);
    writeFileSync(SRV_CRT, signCsrRaw(csr, "/CN=Solar Monitor Hub", [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature",
      "extendedKeyUsage=serverAuth",
      `subjectAltName=DNS:${SERVER_NAME}`,
    ]));
  }
  for (const f of [CA_KEY, SRV_KEY]) execFileSync("chmod", ["600", f]);
}

function tlsMaterial(): { key: string; cert: string; ca: string } {
  return { key: readFileSync(SRV_KEY, "utf8"), cert: readFileSync(SRV_CRT, "utf8"), ca: caPem() };
}

function caPem(): string {
  return readFileSync(CA_CRT, "utf8");
}

/** CA fingerprint as lowercase hex without colons; the pairing QR carries it. */
function caFingerprint(): string {
  return new X509Certificate(caPem()).fingerprint256.replaceAll(":", "").toLowerCase();
}

function signCsrRaw(csrPem: string, subject: string, ext: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "solar-pki-"));
  try {
    const csrFile = join(dir, "req.csr");
    const extFile = join(dir, "ext.cnf");
    writeFileSync(csrFile, csrPem);
    writeFileSync(extFile, ext.join("\n") + "\n");
    // Proves the requester holds the private key matching the public key.
    openssl(["req", "-in", csrFile, "-noout", "-verify"]);
    return openssl([
      "x509", "-req", "-in", csrFile, "-CA", CA_CRT, "-CAkey", CA_KEY,
      "-set_serial", "0x" + randomBytes(16).toString("hex"),
      "-days", TEN_YEARS, "-sha256", "-subj", subject, "-extfile", extFile,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- paired devices ----

function loadDevices(): Device[] {
  try {
    return JSON.parse(readFileSync(DEVICES, "utf8")) as Device[];
  } catch {
    return [];
  }
}

function saveDevices(devices: Device[]): void {
  writeFileSync(DEVICES, JSON.stringify(devices, null, 2) + "\n", { mode: 0o600 });
}

/** Is this client certificate (by fingerprint) a paired, non-revoked device? */
function isActiveDevice(fingerprint256: string): boolean {
  return loadDevices().some((d) => d.fingerprint256 === fingerprint256 && !d.revoked);
}

const revokeListeners: ((fingerprint256: string) => void)[] = [];

/** Called with a device's fingerprint when it is revoked, so open
 *  connections (live streams) can be closed right away. */
function onRevoke(cb: (fingerprint256: string) => void): void {
  revokeListeners.push(cb);
}

function revokeDevice(id: string): boolean {
  const devices = loadDevices();
  const d = devices.find((x) => x.id === id);
  if (!d || d.revoked) return false;
  d.revoked = new Date().toISOString();
  saveDevices(devices);
  console.log(`[pki] revoked device ${id} (${d.name})`);
  for (const cb of revokeListeners) cb(d.fingerprint256);
  return true;
}

// ---- pairing tokens (one-time, short-lived, in memory only) ----

const TOKEN_TTL_MS = 10 * 60 * 1000;
const tokens = new Map<string, number>(); // token -> expiry (ms)

function newPairToken(): { token: string; expires: number } {
  const now = Date.now();
  for (const [t, exp] of tokens) if (exp < now) tokens.delete(t);
  const token = randomBytes(24).toString("base64url");
  const expires = now + TOKEN_TTL_MS;
  tokens.set(token, expires);
  return { token, expires };
}

/** Consume a token: true once, if it exists and hasn't expired. */
function takeToken(token: string): boolean {
  const now = Date.now();
  for (const [t, exp] of tokens) {
    const a = Buffer.from(t), b = Buffer.from(token);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      tokens.delete(t);
      return exp >= now;
    }
  }
  return false;
}

/** Sign a phone's CSR in exchange for a valid pairing token. */
function claimPairing(token: string, name: string, csrPem: string): { cert: string; ca: string; device: Device } {
  if (!takeToken(token)) throw new PairError(403, "pairing code expired or already used");
  if (!/^-----BEGIN CERTIFICATE REQUEST-----[\s\S]+-----END CERTIFICATE REQUEST-----\s*$/.test(csrPem))
    throw new PairError(400, "bad certificate request");
  const id = randomBytes(6).toString("hex");
  const cleanName = (name || "Phone").replace(/[^\p{L}\p{N} ._-]/gu, "").slice(0, 40) || "Phone";
  let cert: string;
  try {
    cert = signCsrRaw(csrPem, `/CN=solar-device-${id}`, [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature",
      "extendedKeyUsage=clientAuth",
    ]);
  } catch {
    throw new PairError(400, "certificate request rejected");
  }
  const device: Device = {
    id,
    name: cleanName,
    fingerprint256: new X509Certificate(cert).fingerprint256,
    created: new Date().toISOString(),
  };
  saveDevices([...loadDevices(), device]);
  console.log(`[pki] paired device ${id} (${cleanName})`);
  return { cert, ca: caPem(), device };
}


return { ensurePki, tlsMaterial, caPem, caFingerprint, loadDevices, isActiveDevice, onRevoke, revokeDevice, newPairToken, claimPairing };
}

export class PairError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
