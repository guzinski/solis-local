# Solar Monitor Android

The Android app displays the existing dashboard in a WebView. After linking once
at home, it automatically tries the home HTTPS address and then the VPS HTTPS
address. A WireGuard app is not required on the phone.

The UI supports en-US and pt-BR and follows the device language by default.
The dashboard's footer also has a language selector. Dates, numbers, chart labels,
connection states and native pairing/camera screens are localized. Version/build
metadata lives in `public/build-info.json`; Gradle reads it when creating the APK.
Inside the app the footer identifies the installed APK version, so an older
install does not display the latest dashboard build as its own version.

Refresh shows a progress indicator while checking the routes and loading the
page. Retry actions are shown only after an actual error; they remain hidden
during a pending connection or pairing request.
Pull down while the dashboard is scrolled to the top to refresh. The large
toolbar refresh button is removed; an equivalent action remains in the overflow
menu for accessibility. Refreshing the dashboard reads stored data and does not
trigger another Modbus request.

If the gateway is reachable but the dashboard is unavailable, browser navigation
gets a localized error page with a retry action and collapsed JSON diagnostics.
API endpoints retain their JSON error contract. The Android app also shows a
native connection error when a page cannot load, including when there is no
HTTP response at all.

```text
Phone -- HTTPS + its own device certificate --> VPS TCP relay
                                                   |
                                            existing WireGuard
                                                   |
                                        Solar mobile gateway :9443
                                                   |
                                        dashboard 127.0.0.1:3100
```

The independent gateway never opens Modbus or the history database. It has its
own certificate authority under `data/mobile/pki/`, separate from any camera
application. Phone keys are generated inside Android Keystore and are not
exported. Pairing uses a ten-minute single-use QR code containing the server CA
fingerprint and connection addresses. The phone sends a signed CSR, verifies
the returned certificate against the pinned CA and its own public key, then
stores its device certificate. Both home and remote dashboard connections use
mutual TLS. The WebView fetches content through the authenticated native HTTPS
client; it never accepts arbitrary TLS errors or third-party origins.

## Run the gateway

1. Copy `deploy/mobile.env.example` to `.env.mobile.local` and set the addresses.
2. Keep the existing dashboard running on port 3100.
3. Run `npm run mobile`, or install the independent user service with
   `bash scripts/install-mobile-service.sh`. Logs:
   `journalctl --user -u solar-mobile -f`.
4. Under WSL, run `deploy/windows-mobile-ports.ps1` in an elevated PowerShell,
   passing `-WslAddress <current-wsl-ip> -LanAddress <home-pc-ip>`.
   This exposes the pairing claim/APK and authenticated HTTPS ports to the LAN.
   Repeat after the WSL address changes. Existing camera ports stay separate.
5. On the VPS, run `sudo bash vps-solar-forward.sh <home-wireguard-ip> 9443`
   using `deploy/vps-solar-forward.sh`. It creates separate `solar-mobile`
   systemd units and opens TCP 9443 in UFW if active. Also allow that port in a
   provider firewall if one is configured. It does not modify WireGuard keys,
   existing peers, the camera relay or other web services.

### Automatic startup and WSL recovery

Install the reader as a user service with `bash scripts/install-monitor-service.sh`.
It preserves the current 120-second reply deadline and diagnostic logging. Stop
any terminal reader first; the installer refuses to start when another process
already owns the dashboard port. Do not enable both the legacy system service
and the new user reader. User logs: `journalctl --user -u solar-monitor -f`.

On Windows/WSL, run `deploy/windows-autostart.ps1` elevated with
`-RepoPath <linux-project-path>` and optionally `-Distro <distribution>`.
It installs the **Solar Monitor** logon task, enables user lingering for startup,
and runs a loop that brings WSL/user services back after an unexpected shutdown.
It updates only Solar's LAN ports (3100, 3101, 9443), leaving the camera task and
ports alone. Logs are in `%ProgramData%\SolarMonitor\boot.log`.

The same setup installs `solar-capture.service`, a separate passive packet
capture that starts with WSL. It runs as the owner with only `CAP_NET_RAW`,
records eight rotating 8 MB files per session under `data/captures/`, and stops
with SIGINT so tcpdump flushes its output. It never sends Modbus probes. Session
directories accumulate across restarts; archive incidents and remove old sessions
as needed. These services cannot survive WSL itself being stopped, but the Windows
task restarts WSL while the Windows user remains logged in.

Pairing administration is available only on the home computer at
`http://127.0.0.1:3101`, with loopback address and Host/Origin checks. Do not
expose the pairing port through the VPS. The HTTPS port accepts only active
device certificates; revoking a phone closes its current connections too.

## Build and link a phone

Requires Android SDK 37, build tools 36, JDK 21 and Android 9 or newer on the phone.
Set `android/local.properties` to the local SDK path (gitignored), then run:

```bash
cd android
./gradlew :app:assembleDebug :app:lintDebug
```

The initial development APK is `android/app/build/outputs/apk/debug/app-debug.apk`,
signed with the workstation's standard Android debug key. Keep that key for
updates to this development install; production release signing should use a
dedicated backed-up key before distribution beyond personal testing.

On the phone, open the normal LAN dashboard and tap **Baixar app Android** in
the footer (direct download: `http://<home-pc-ip>:3101/app.apk`), install it, and choose
**Vincular celular**. On the home computer, open `http://127.0.0.1:3101` and
generate a code. Scan it while the phone is on the home Wi-Fi. Then turn Wi-Fi
off and refresh in the app to verify the VPS route. Certificate revocation is
available on the same local setup page.

The PC, WSL, monitor, gateway and existing home-to-VPS tunnel must be running.
Do not copy the CA/device keys, pairing codes or local environment files into
Git or chat. Back up `data/mobile/pki/` privately; losing the CA requires linking
phones again. QR codes contain short-lived linking authority, not phone keys.

## Validation

`npm run check` covers the TypeScript sources. The integration test
`node --disable-warning=ExperimentalWarning tests/mobile-gateway.test.ts`
uses temporary local HTTP/HTTPS listeners and a temporary CA to verify one-use
pairing, rejection without a client certificate, authenticated proxying, blocked
administration with an untrusted Host, and revocation. Android compile and lint
checks do not replace the first QR/Keystore/WebView test on a physical phone.
