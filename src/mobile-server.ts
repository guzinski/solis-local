import { loadEnv } from "./env.ts";
import { createMobileGateway } from "./mobile/gateway.ts";
loadEnv(); loadEnv(".env.mobile.local");
for (const key of ["SOLAR_MOBILE_LAN", "SOLAR_MOBILE_REMOTE", "SOLAR_MOBILE_PAIRING"]) {
  if (!process.env[key]) throw new Error(`${key} is required in .env.mobile.local`);
}
const adminPort = Number(process.env.SOLAR_MOBILE_ADMIN_PORT ?? 3101);
const tlsPort = Number(process.env.SOLAR_MOBILE_TLS_PORT ?? 9443);
const gateway = createMobileGateway({ dataDir: process.env.SOLAR_MOBILE_DATA ?? "data/mobile",
  upstream: process.env.SOLAR_MOBILE_UPSTREAM ?? "http://127.0.0.1:3100",
  lan: process.env.SOLAR_MOBILE_LAN!, remote: process.env.SOLAR_MOBILE_REMOTE!, pairing: process.env.SOLAR_MOBILE_PAIRING!,
  adminPort, tlsPort, apk: "android/app/build/outputs/apk/debug/app-debug.apk" });
gateway.secure.listen(tlsPort, "0.0.0.0", () => console.log(`Solar mobile HTTPS :${tlsPort}`));
gateway.admin.listen(adminPort, "0.0.0.0", () => console.log(`Setup on this computer: http://127.0.0.1:${adminPort}`));
for (const server of [gateway.secure, gateway.admin]) server.on("error", (error) => { console.error(error.message); process.exit(1); });
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => {
  gateway.secure.closeAllConnections(); gateway.admin.closeAllConnections();
  gateway.secure.close(); gateway.admin.close();
});
