# SOTAX ST-50 Print Capture Proxy

A lightweight Node.js TCP proxy that intercepts raw print jobs from the SOTAX ST-50,
saves them as PostScript (.ps) files, and forwards them to the Xerox B310 printer.

---

## Requirements

- **Node.js** (v14 or later): https://nodejs.org
- No npm packages needed — uses Node.js built-ins only.

---

## Setup

### 1. Find your machine's IP address

Open Command Prompt and run:

```
ipconfig
```

Look for the IPv4 address on the network interface connected to the ST-50/printer
network (e.g. `192.168.1.50`). This is the IP you'll enter into the ST-50.

### 2. Find the Xerox B310's IP address

The Xerox B310 displays its IP on the front panel when powered on and connected
to ethernet. Note it down (e.g. `192.168.1.100`).

### 3. Edit config.json

Open `config.json` and set `printerHost` to the Xerox's IP:

```json
{
  "listenPort": 9100,
  "printerHost": "192.168.1.100",   ← Your Xerox B310 IP here
  "printerPort": 9100,
  "outputDir": "./captured_jobs",
  "forwardToPrinter": true,
  "logLevel": "verbose"
}
```

### 4. Allow port 9100 through Windows Firewall

Run this in an **Administrator** Command Prompt:

```
netsh advfirewall firewall add rule name="Print Proxy Port 9100" ^
  dir=in action=allow protocol=TCP localport=9100
```

### 5. Configure the ST-50

In the ST-50's network/printer settings, enter **this PC's IP address**
instead of the Xerox's IP. The port should be 9100 (or left as default).

### 6. Start the proxy

Double-click `start-proxy.bat`, or run in Command Prompt:

```
node proxy.js
```

---

## Files

| File | Purpose |
|------|---------|
| `proxy.js` | Main proxy server |
| `resend.js` | Manually re-send a captured file to the printer |
| `config.json` | Configuration (edit this) |
| `start-proxy.bat` | Windows launcher |
| `captured_jobs/` | Saved .ps files appear here (auto-created) |

---

## Re-sending a captured job

If you need to re-print a saved job:

```
node resend.js captured_jobs\job_20240518_143022.ps
```

---

## Config options

| Option | Default | Description |
|--------|---------|-------------|
| `listenPort` | `9100` | Port this proxy listens on |
| `printerHost` | — | Xerox B310 IP address |
| `printerPort` | `9100` | Xerox port (rarely needs changing) |
| `outputDir` | `./captured_jobs` | Where .ps files are saved |
| `forwardToPrinter` | `true` | Set `false` to capture only, no printing |
| `logLevel` | `verbose` | `verbose` / `normal` / `quiet` |

---

## Troubleshooting

**Port 9100 already in use**
> Windows Print Spooler can claim port 9100. Open Services (services.msc),
> find "Print Spooler", stop it, and set it to Manual — or change `listenPort`
> to 9101 and update the ST-50 accordingly.

**ST-50 can't connect**
> Confirm Windows Firewall allows port 9100 (see step 4).
> Confirm both devices are on the same subnet.

**ST-50 shows "printer not found" but your laptop can connect**
> Run `node diagnose.js <proxy-ip>` on a PC on the same network as the ST-50.
> If TCP succeeds but PJL probes get no response, restart the proxy (newer versions
> answer `@PJL INFO ID` / `STATUS` so the ST-50 can recognize the host as a printer).
> While testing, watch the proxy console: if you never see `New connection from …`
> when the ST-50 tries to print, the ST-50 is not reaching this PC (wrong IP, VLAN,
> or firewall). Also allow ICMP (ping) on the proxy PC — some instruments ping first.

**Jobs save but don't print**
> Check `printerHost` in config.json is correct.
> Try pinging the Xerox from this PC: `ping 192.168.1.100`

**Captured file is 0 bytes**
> The ST-50 may have disconnected before sending data. Check the ST-50's
> network status / job log.
