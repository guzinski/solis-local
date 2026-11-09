// Finds the datalogger stick on the LAN after its DHCP address changes. It looks
// for the stick's own web login (HTTP 401, realm "solis") on the same /24 as the
// last known address. Read-only: one plain HTTP GET per address, no Modbus.
const TIMEOUT_MS = 1500;
const CONCURRENCY = 32;

// True when the Solis stick's own web login answers at this address (HTTP 401,
// realm "solis"). Confirms the stick is powered and on the network even when its
// Modbus server (port 502) is dead.
export async function isSolisStick(host: string, timeoutMs = TIMEOUT_MS): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}/`, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    await res.body?.cancel();
    return res.status === 401 && /realm="?solis/i.test(res.headers.get("www-authenticate") ?? "");
  } catch {
    return false;
  }
}

// Returns the stick's address, or null if none or more than one was found
// (more than one is ambiguous, so it's safer not to guess).
export async function locateStick(lastHost: string): Promise<{ host: string | null; candidates: string[] }> {
  const match = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(lastHost);
  if (!match) return { host: null, candidates: [] };
  const hosts = Array.from({ length: 254 }, (_, i) => `${match[1]}.${i + 1}`);
  const candidates: string[] = [];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let host = hosts.shift(); host; host = hosts.shift()) {
        if (await isSolisStick(host)) candidates.push(host);
      }
    }),
  );
  candidates.sort((a, b) => Number(a.split(".")[3]) - Number(b.split(".")[3]));
  return { host: candidates.length === 1 ? candidates[0] : null, candidates };
}
