# Solar Monitor

A local-first monitor for a Solis grid-tied string inverter. It reads the
inverter through its Wi-Fi datalogger stick over **Modbus TCP on your LAN**,
keeps its own history, and serves a phone-friendly dashboard. No vendor cloud
is in the path.

**Read-only.** The Modbus client (`src/modbus.ts`) implements only function
code 04 (Read Input Registers). Nothing in this app can change an inverter
setting, and the HTTP API refuses anything but GET.

## Setup

Requires Node.js 22.13 or newer (it runs TypeScript directly and uses the
built-in `node:sqlite`).

```bash
cp .env.example .env.local     # then set STICK_HOST to the stick's LAN IP
npm install                    # dev tooling only (type-checking)
npm start                      # dashboard on http://<this-machine>:3100
```

Give the stick a DHCP reservation in your router so its address doesn't change.

| Variable | Default | Meaning |
|---|---|---|
| `STICK_HOST` | — | Datalogger IP (required) |
| `STICK_PORT` | `502` | Modbus TCP port |
| `STICK_UNIT` | `1` | Inverter Modbus address (see the inverter's screen) |
| `POLL_SECONDS` | `60` | Seconds between reads (minimum 5) |
| `ALERT_MINUTES` | `15` | Desktop alert after this long without readings in daylight (`0` = off; Windows toast under WSL) |
| `PLANT_NAME` | `My solar plant` | Title on the dashboard |
| `PLANT_KWP` | — | Panel capacity in kWp; enables % of capacity and kWh/kWp |
| `HTTP_HOST` / `HTTP_PORT` | `0.0.0.0` / `3100` | Dashboard listener |
| `DB_PATH` | `data/solar.db` | History database |

`npm run check` type-checks the project.

## How it works

```
Phone/browser ──HTTP──► server (src/) ──Modbus TCP :502, FC04 only──► datalogger stick ──► inverter
                           │
                           └── data/solar.db (every reading + day/month/year totals)
```

- **Polling:** one connection per read, a few slow retries when the stick is
  busy. The stick refuses connections while it uploads, and Solis asks for at
  least 300 ms between frames.
- **Night:** a grid-tied inverter powers the stick from the panels, so it is
  off after sunset. The dashboard shows "Asleep" and the last values. This is
  normal, not an error.
- **History:** every reading is stored. Day, month and year totals come from the
  inverter's own counters (today/yesterday, this/last month, this/last year), so
  they stay right even if polls are missed. Readings from before the app started
  exist only in the vendor cloud.
- **Registers:** the 0-based input-register block 2999–3044 of a Solis string
  inverter (`src/inverter.ts`). The grid voltage address was matched against
  live values, not taken from the published map.

## Datalogger notes

- Tested with an S5-WIFI-ST stick: web page with HTTP Basic auth, Modbus TCP on
  502, nothing on 8899.
- Frequent local polling has been reported to knock SolisCloud offline on some
  S5 firmware. Keep `POLL_SECONDS` gentle unless the stick's internet access is
  blocked.
- The stick's Modbus service sometimes stops answering for hours while its web
  page still works. Unplugging the stick for 10 seconds restarts it without
  touching its settings.
- Modbus TCP has no authentication: anything on the LAN can talk to port 502.

## Scripts

- `node scripts/discover.ts <a.b.c>`: find hosts with stick-like ports open.
- `node scripts/lan-snapshot.ts <a.b.c> baseline|compare`: spot new devices
  (Windows/WSL only; it uses `powershell.exe`).
- `node scripts/probe-modbus.ts <ip> [start] [count] [unit]`: one raw FC04 read.
- `node scripts/import-report.ts <Plant Report.xls> ...`: import SolisCloud
  "Plant Report" exports. A yearly report fills months; a monthly report fills
  days. Only the period and energy columns are read.
- `node scripts/backfill.ts 2026-01=812 ...`: enter past months or days the
  inverter no longer reports over Modbus (copy them from its screen's energy
  records). `--list` shows what's stored and how much of the year counter is
  still unsplit.

## Privacy

Real IPs, serials and credentials live only in `.env.local` and `data/`, both
gitignored. Keep it that way in code, docs and commit messages.
