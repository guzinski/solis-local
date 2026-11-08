// Desktop alert when the stick stops answering in daylight. Under WSL it shows a
// Windows toast through powershell.exe; elsewhere it only logs to the console.
import { execFile } from "node:child_process";
import type { LinkState } from "./poller.ts";
import type { Reading } from "./inverter.ts";

const APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function notify(title: string, body: string): void {
  console.log(`alert: ${title}: ${body}`);
  const script = [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
    "$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$x = $t.GetElementsByTagName('text')",
    `$x.Item(0).AppendChild($t.CreateTextNode(${quote(title)})) > $null`,
    `$x.Item(1).AppendChild($t.CreateTextNode(${quote(body)})) > $null`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${quote(APP_ID)}).Show([Windows.UI.Notifications.ToastNotification]::new($t))`,
  ].join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { timeout: 20000 }, (err) => {
    if (err && (err as NodeJS.ErrnoException).code !== "ENOENT") console.log(`alert: toast failed: ${err.message}`);
  });
}

// Same daylight rule as the dashboard: the stick going quiet at sunset is normal.
export function isDaylightOutage(last: Reading | null, now = new Date()): boolean {
  const hour = now.getHours();
  return last !== null && last.pvW >= 300 && hour >= 6 && hour < 19;
}

const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export class OutageAlert {
  minutes: number;
  alerted = false;

  constructor(minutes: number) {
    this.minutes = minutes;
  }

  check(state: LinkState, last: Reading | null, now = Date.now()): void {
    if (!this.minutes) return;
    if (state.online) {
      if (this.alerted) notify("Solar: stick is back", `Readings resumed at ${clock(now)}.`);
      this.alerted = false;
      return;
    }
    if (this.alerted || state.lastSeen === null) return;
    if (now - state.lastSeen < this.minutes * 60_000) return;
    if (!isDaylightOutage(last, new Date(now))) return;
    this.alerted = true;
    const since = clock(state.lastSeen);
    if (state.diagnosis === "modbus-down") {
      notify(
        "Solar: stick's Modbus stopped",
        `The stick is online but refusing readings since ${since}. Unplug it for 10 seconds and plug it back in.`,
      );
    } else if (state.diagnosis === "unreachable") {
      notify("Solar: stick not on the network", `No answer at ${state.host} since ${since}. Searching the LAN for it.`);
    } else {
      notify(
        "Solar: stick not answering",
        `No readings since ${since}. If it lasts, unplug the stick for 10 seconds and plug it back in.`,
      );
    }
  }
}
