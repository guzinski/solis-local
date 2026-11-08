import { existsSync, readFileSync } from "node:fs";

// Loads .env.local into process.env without overriding the real environment.
export function loadEnv(file = ".env.local"): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

export type Config = {
  stickHost: string;
  stickPort: number;
  stickUnit: number;
  pollSeconds: number;
  alertMinutes: number;
  plantName: string;
  plantKwp: number | null;
  httpHost: string;
  httpPort: number;
  dbPath: string;
};

export function readConfig(): Config {
  loadEnv();
  const env = process.env;
  const stickHost = env.STICK_HOST ?? "";
  if (!stickHost || stickHost === "your_stick_ip") {
    throw new Error("STICK_HOST is not set; copy .env.example to .env.local and fill it in");
  }
  return {
    stickHost,
    stickPort: Number(env.STICK_PORT ?? 502),
    stickUnit: Number(env.STICK_UNIT ?? 1),
    pollSeconds: Math.max(5, Number(env.POLL_SECONDS ?? 60)),
    alertMinutes: Math.max(0, Number(env.ALERT_MINUTES ?? 15)) || 0,
    plantName: env.PLANT_NAME ?? "My solar plant",
    plantKwp: Number(env.PLANT_KWP) > 0 ? Number(env.PLANT_KWP) : null,
    httpHost: env.HTTP_HOST ?? "0.0.0.0",
    httpPort: Number(env.HTTP_PORT ?? 3100),
    dbPath: env.DB_PATH ?? "data/solar.db",
  };
}
