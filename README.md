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
| `POLL_SECONDS` | `300` | Seconds between reads (minimum 5; ±10% jitter above 60) |
| `MODBUS_REPLY_TIMEOUT_SECONDS` | `10` | Reply deadline, 10–300 s; `120` enables the longer-wait experiment and disables immediate retries |
| `MODBUS_TRACE_PATH` | unset | Optional rotating JSONL diagnostic log; keep it under `data/` |
| `ALERT_MINUTES` | `15` | Desktop alert after this long without readings in daylight (`0` = off; Windows toast under WSL) |
| `PLANT_NAME` | `My solar plant` | Title on the dashboard |
| `PLANT_KWP` | — | Panel capacity in kWp; enables % of capacity and kWh/kWp |
| `HTTP_HOST` / `HTTP_PORT` | `0.0.0.0` / `3100` | Dashboard listener |
| `DB_PATH` | `data/solar.db` | History database |

`npm run check` type-checks the project.

## Capture the next Modbus failure

Install `tcpdump` once, then run this from the project directory in a terminal
on the machine that runs the monitor:

```bash
sudo apt-get install tcpdump
npm run diagnose
```

Stop any existing solar monitor first. `npm run diagnose` asks sudo to start a
passive capture, waits for tcpdump to report that it is listening, then starts
one monitor with a **120-second reply deadline** and diagnostic logging enabled.
The monitor runs as your normal user. If capture cannot start, it does not start
polling. `npm run capture` starts only the capture if you need separate terminals.

Start this before restarting the stick. The app marks a still-unanswered request
at 10 seconds, continues waiting on that same socket until 120 seconds, and does
not resend or reconnect during that wait. A late valid reply completes normally.
At 120 seconds it logs the timeout and closes the connection; the next attempt
waits for the next scheduled poll. TCP keepalive remains enabled as before.
This changes timeout handling for an experiment; it is not a proven fix.

Evidence stays local and gitignored:

- `data/diagnostics/modbus.jsonl` plus `.1`–`.3`: four rotating files, about
  4 MB each. Each event includes UTC time, monotonic elapsed time, process/run ID,
  connection ID, endpoint details, transaction ID where applicable, request and
  received bytes, deadline markers, and local/peer socket events. Startup records
  the effective settings. A write callback is explicitly **not** a TCP ACK.
- `data/captures/<UTC-start>/modbus.pcap*`: eight rotating files, about 8 MB
  each, containing only TCP traffic on the configured Modbus port. A port filter
  keeps working across DHCP changes. It can include other traffic on that port
  visible from this machine, but not other clients' traffic on a switched LAN.
  Stick-to-cloud traffic and HTTP credentials are not included.

After a failure, leave capture running through the 120-second deadline, cleanup,
and preferably the next scheduled connection attempt. Then press Ctrl+C in the
diagnostic terminal to flush the capture and stop the monitor. Preserve the whole
capture directory and all four JSONL files before the next run. Rolling files
eventually overwrite old evidence; they do not automatically freeze on failure.
Check tcpdump's final dropped-packet count when interpreting a capture.

To review packets with absolute TCP sequence numbers and UTC timestamps:

```bash
TZ=UTC tcpdump -nn -tttt -S -r data/captures/<UTC-start>/<pcap-file>
```

Correlate the connection's local port and request bytes in the JSONL trace with
the pcap. `reply-slow` followed by a valid reply shows recovery during the longer
wait. A peer FIN/RST before `local-end` differs from a client-initiated cleanup.
ACKs prove delivery to the TCP stack, not successful Modbus processing. A capture
cannot by itself prove an internal firmware deadlock or an RS485 collision.

For normal operation, exit the diagnostic run and use `npm start`; the deadline
defaults to 10 seconds unless overridden in `.env.local`. Keep the poll interval
unchanged between comparative runs. `npm test` exercises late replies, timeout
cleanup, peer closure, connection cancellation, malformed replies, log rotation,
and retry suppression without contacting the stick.

## How it works

```
Phone/browser ──HTTP──► server (src/) ──Modbus TCP :502, FC04 only──► datalogger stick ──► inverter
                           │
                           └── data/solar.db (every reading + day/month/year totals)
```

- **Polling:** one persistent connection, reused for every read and reopened
  only when it breaks. With a new connection per read, the S5-WIFI-ST's port
  502 stopped accepting connections after minutes to hours and stayed closed
  until the stick was restarted. The suspected cause is that it serves very
  few clients and doesn't reliably free a slot when a connection closes. A failed read is retried
  once, 20 s later. Ctrl+C closes the connection properly before exiting.
- **Failures:** the dashboard and alerts tell apart *busy* (clears by itself),
  *Modbus stopped* (refused for 10 min while the stick is on the network:
  unplug the stick for 10 s) and *unreachable* (night, or a new DHCP address,
  which the app finds by scanning for the stick's login page). Every attempt is
  logged; `node scripts/attempts.ts [date] [--all]` prints the timeline.
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

## Android app and remote access

The Android app displays the dashboard in a WebView, with native QR scanning,
device certificates and automatic home/remote connection selection. It follows
the phone's light/dark theme and supports en-US and pt-BR. The footer shows the
installed app version/build (or dashboard version in a browser), a language
selector, and the polling interval in minutes. After linking once at home, no VPN app is needed
on the phone: the independent mobile gateway uses the existing home-to-VPS
WireGuard tunnel and authenticates each phone over HTTPS.

See [Android setup, build and deployment](docs/android-mobile.md). The LAN
dashboard includes an APK download link in its footer. The gateway runs
separately from the monitor and does not poll the inverter.

### Remote access over an existing WireGuard tunnel

If the monitor's machine and your phone already have WireGuard profiles on the
same VPS, the dashboard can use that private network directly. No additional
public dashboard port or web proxy is needed.

1. Keep WireGuard active on the machine running the monitor. Its HTTP listener
   must include the WireGuard address (`HTTP_HOST=0.0.0.0` does this).
2. Activate the phone's WireGuard profile. Its peer `AllowedIPs` must include
   the home machine's tunnel address, and the VPS must permit forwarding between
   the phone and home peers. Reuse existing working settings.
3. On the phone, open `http://<home-wireguard-ip>:3100`. Turn Wi-Fi off to check
   that access works through mobile data. The normal LAN URL remains available.

The current dashboard has no application login. Access over this route relies
on the WireGuard peer keys and firewall rules. Keep port 3100 private; do not
forward it from the VPS's public interface. The PC, WSL, monitor and home tunnel
must stay running for remote access. Treat phone profile files and QR codes as
credentials; keep them out of this repository and chat logs.

## Privacy

Real IPs, serials and credentials live only in `.env.local`, `.env.mobile.local` and `data/`, all
gitignored. Keep it that way in code, docs and commit messages.
