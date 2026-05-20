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
  "printerHost": "192.168.1.100",
  "printerPort": 9100,
  "mode": "transparent",
  "organizeByJobMeta": true,
  "storagePathTemplate": "{productId}/lot_{lot}/{side}",
  "captureJobs": true,
  "outputDir": "./captured_jobs",
  "logLevel": "verbose"
}
```

**`mode`: `transparent` (recommended)** — pipes every byte ST-50 ↔ Xerox on one TCP
session, like the old direct ethernet cable. Printer PJL/status replies go back to the
ST-50 unchanged. **`capture`** — older mode that buffers and interprets PJL separately.

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

### 7. Sniff the Xerox directly (debug)

From the proxy PC (same network as the printer):

```
run-sniff-portable.bat 10.3.10.209
```

Saves raw printer replies under `sniff_logs/`. Compare with proxy log lines
`Printer → ST-50` in transparent mode.

### 8. Compare proxy vs real printer (when ST-50 says "not found")

On the intercept PC, with the Xerox IP from its front panel:

```
node compare.js 10.3.25.25 <xerox-ip>
```

If the proxy shows **no PJL response** but the Xerox does, set `relayPjlToPrinter: true`
in `config.json` (default) and restart `node proxy.js`. The proxy will forward
discovery probes to the Xerox and return the same answers the ST-50 already accepts.

While the ST-50 tries to print, watch the proxy console:
- **No** `New connection` → ST-50 is not reaching this PC (wrong IP, firewall, or port).
- **`New connection` + First bytes** → note the hex dump; that is what the ST-50 sent.

Check what is bound to port 9100 on the intercept PC:

```
netstat -ano | findstr :9100
```

Only `node.exe` (proxy.js) should listen while testing.

---

## Files

| File | Purpose |
|------|---------|
| `proxy.js` | Main proxy server (`mode`: `transparent` or `capture`) |
| `sniff.js` | Query Xerox port 9100 and save raw responses |
| `convert-ps.js` | Convert captured `.ps` to CSV / TXT |
| `run-convert-portable.bat` | Run converter with bundled Node |
| `resend.js` | Manually re-send a captured file to the printer |
| `config.json` | Configuration (edit this) |
| `start-proxy.bat` | Windows launcher |
| `captured_jobs/` | Saved .ps files appear here (auto-created) |

---

## Converting captured PostScript to CSV / Excel

With **`autoConvert`: `true`** in `config.json` (enabled by default in the sample config),
each captured job is converted automatically next to the `.ps` file under a `converted/` subfolder.

### Storage layout (organized jobs)

When `organizeByJobMeta` is true, paths are parsed from the ST-50 PJL header, e.g.:

`@PJL JOB NAME="1A;'1392B-10';'002';20260520;062136;ST50;00215"`

| Field | Folder token | Example |
|-------|----------------|---------|
| Product ID | `{productId}` | `1392B-10` |
| Lot / batch | `{lot}` or `{batch}` | `002` |
| Press side (Comment) | `{side}` | `LEFT`, `RIGHT`, `LSFP`, `RSFP`, `L`, `R` (optional) |

`{side}` is omitted from the path when not found on the report. Test type (`IN_PR_HARDNESS`, `UNCOATED`) is still included in the **filename**, not as a folder.

Example tree:

```
captured_jobs/
  1392B-10/
    lot_002/
      RIGHT/
        job_20260520_062136_IN_PR_HARDNESS_RIGHT.ps
        converted/
          job_20260520_062136_IN_PR_HARDNESS_RIGHT.csv
```

PJL-only discovery probes (no print job) are not saved. Set `"organizeByJobMeta": false` to use a flat `captured_jobs/` folder again.

ST-50 jobs are text positioned on a grid (not a flat PDF). You can also convert manually:

```
run-convert-portable.bat captured_jobs\job_20260520_083956.ps
run-convert-portable.bat captured_jobs
run-convert-portable.bat captured_jobs\job.ps --form
```

Outputs go to `captured_jobs/converted/`:

| File | Use |
|------|-----|
| `*.csv` | Open in Excel / Google Sheets |
| `*.txt` | Fixed-width preview |
| `*.csv` | One CSV per job (all pages combined) |
| `*.json` | Structured data for scripts |

Conversion uses **drawn table cell rectangles** in the PostScript for a 1:1 grid (one CSV cell per printed cell).
Re-run `run-convert-portable.bat captured_jobs` after upgrading if you still have old merged CSVs.

**PDF (optional):** install [Ghostscript](https://ghostscript.com/releases/gsdnld.html), then:

```
gswin64c -dNOPAUSE -sDEVICE=pdfwrite -o report.pdf captured_jobs\job.ps
```

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
| `mode` | `transparent` | `transparent` = pipe bytes; `capture` = buffer/PJL mode |
| `organizeByJobMeta` | `true` | Folder per product / lot / press (from PJL `JOB NAME`) |
| `storagePathTemplate` | `{productId}/lot_{lot}/{side}` | Path under `outputDir` |
| `captureJobs` | `true` | In transparent mode, save ST-50→printer stream on close |
| `autoConvert` | `false` | After each `.ps` capture, write CSV/TXT/JSON |
| `autoConvertForm` | `false` | Legacy merge mode (leave `false` for 1:1 cells) |
| `autoConvertDir` | `converted` | Folder under `outputDir` for converted files |
| `outputDir` | `./captured_jobs` | Where captured streams are saved |
| `forwardToPrinter` | `true` | `capture` mode only |
| `relayPjlToPrinter` | `true` | `capture` mode only |
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
