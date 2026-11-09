# Modbus outage investigation — 2026-11-09

The evidence points to a failure of the logger's local Modbus service or its
connection handling. It does not establish which request or internal event
triggers that failure. An RS485/cloud scheduling collision remains a hypothesis.
No application behavior or device settings were changed during this audit.

## Evidence from the local database

Times are America/Sao_Paulo. The attempts table starts on November 8 at 16:07;
the earlier incidents in the supplied history cannot be independently checked
against this table.

| Incident | Recorded transition | What it establishes |
| --- | --- | --- |
| Nov 8 afternoon | Last success 16:10:10; connection refused at 16:11:10 | The failing attempt never sent a Modbus request. The service became unavailable between successful reads, or refused the next connection. |
| Nov 8 dusk | 35 successful reads on one connection; request 36 at 19:04:35 received zero bytes and timed out; subsequent connection refused | Last reading was only 20 W AC / 176 W PV. This could be normal inverter shutdown and should not be counted as a confirmed persistent daytime crash. |
| Nov 9 dawn | 20 successful reads on one connection; request 21 at 05:37:38 received zero bytes and timed out after 10 seconds; reconnect refused at 05:38:08 | The outage began without connection churn. Last reading was 20 W AC / 207 W PV / 26 °C. Refusals continued into daylight, through the latest recorded attempt at 08:59:28. |

The connection log's `dropped` event means **our timeout handler closed the
socket**. It does not mean the stick sent FIN or RST first. A packet capture is
needed to distinguish a service failure, a silent serial request, and a slot
that remains occupied after the client closes.

Continued web access and fresh cloud uploads are user observations; the attempt
records do not independently capture cloud traffic. HTTP availability alone
does not establish cloud availability or the state of the inverter's serial link.

## Application audit

The normal polling loop awaits each complete tick before scheduling another.
Dashboard requests read the database and do not issue Modbus reads. Each poll
sends one FC04 request for 46 input registers starting at wire address 2999.
An offline socket simulation verified the initial request bytes
`00010000000601040bb7002e` and successful parsing of a fragmented 101-byte reply.
There is no observed malformed outbound request or normal-loop overlap.

The audit also reproduced these client defects with fake sockets, without
contacting the stick:

- `src/modbus.ts:75`: the busy guard covers a pending reply, but not connection
  setup. Two simultaneous `read()` calls before TCP connects open two sockets.
  The normal polling loop does not call it this way, so this is a latent defect,
  not an explanation supported by the outage logs.
- `src/modbus.ts:221`: `close()` does not track or cancel a connecting socket.
  A connection can complete and send a read after `close()` returns. Also,
  `Poller.stop()` does not cancel a retry sleeping inside a tick. The server's
  immediate process exit limits these races; they do not explain an uninterrupted
  steady-polling outage.
- `src/modbus.ts:160`: response lengths are not validated before reading register
  values. The malformed frame `00010000000301045c` throws an uncaught RangeError
  from the data handler. Protocol ID, unit and normal function code are also not
  checked. This threatens the app, but the logged failing requests received zero
  bytes, so it does not explain those incidents.
- `src/poller.ts:130`: the diagnostic label becomes `modbus-down` after ten
  minutes even for a responding server returning Modbus exceptions. It therefore
  cannot by itself prove a dead TCP listener. The recorded ECONNREFUSED failures
  provide stronger evidence than this label.
- `src/env.ts:36`: the fallback remains 60 seconds, while `.env.example` says
  300. Loading the existing local configuration returned 300 seconds. That does
  not prove what an already-running older process loaded. Five-minute jitter is
  a traffic reduction experiment, not a demonstrated fix.

`npm run check` passed. Existing uncommitted application changes were preserved.

## Interpretation and external evidence

A five-minute cloud upload cadence does not establish a five-minute RS485 read
cadence: collection and upload may be scheduled separately. There are no serial
traces or cloud timing records here to demonstrate overlapping transactions.
Random jitter changes request timing but cannot guarantee avoidance of internal
work. One persistent connection weakens the connection-churn explanation; it
does not exclude firmware resource leaks, other clients, or failure to release
a slot after a serial timeout.

Both persistent-connection failures began at low production. An inverter-side
communication interruption followed by defective logger recovery is another
plausible trigger. The afternoon failure means low production cannot explain
every incident on its own.

Solis's current developer documentation explicitly lists Modbus TCP support for
S2-WL-ST firmware >= 100101B4. It does not establish support for the S5-WIFI-ST
named in this repository. Confirm the actual logger model and firmware before
choosing a firmware remedy. [Solis documentation](https://developer.soliscloud.com/guide/modbus.html).

The solis_modbus maintainers document S5-WIFI-ST port-502 failures and firmware
dependent cloud coexistence. This supports investigating logger firmware, but
their firmware-update cases are not proof of this reboot-recoverable failure.
[Maintainer troubleshooting](https://github.com/Pho3niX90/solis_modbus#troubleshooting).

## Next diagnostic experiment

1. Record the exact logger firmware and model. After a controlled restart in
   stable daylight, leave every local Modbus client stopped for a baseline
   observation period longer than the prior failures. Check the service once
   at the end; repeated port scans would themselves create client connections.
2. Repeat with one client at the current 300-second interval, keeping request
   size and other conditions unchanged. Passively capture port 502 traffic from
   before the first connection through any failure. Capture must show requests,
   responses, FIN/RST direction, and rejected SYNs; retain captures privately.
3. If the service fails, stop polling and allow a quiet recovery window before
   restarting hardware. Test once afterward to distinguish recovery without
   traffic from a service that requires restart. Use another LAN host for that
   single check if available, to distinguish a client/network-specific refusal.
4. Compare a known independent client in a separate run, never concurrently.
   Reproduction with the same read and another client would substantially
   strengthen the firmware diagnosis. One successful run is not conclusive.

Blocking WAN access is not a definitive serial-collision test: the logger may
continue collecting data and retrying uploads while offline. A firmware fix
confirmed for the exact model, or a compatible direct RS485 connection that
bypasses the logger, are longer-term paths if the logger fault is reproduced.
Direct RS485 wiring requires the exact inverter's port documentation; do not
assume two independent masters can share the logger's serial bus.
