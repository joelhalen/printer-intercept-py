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

#### Multiple ST-50s → different printers

When more than one instrument connects to this proxy, add a `sources` list. Each entry
names the client, maps its IP to a printer, and stores captures under that name:

```json
{
  "printerHost": "10.3.10.48",
  "sources": [
    {
      "name": "st50-line1",
      "from": "10.3.10.49",
      "printerHost": "10.3.10.48"
    },
    {
      "name": "st50-line2",
      "from": "10.3.10.50",
      "printerHost": "10.3.10.52"
    }
  ],
  "unmappedSourceFolder": "_unmapped"
}
```

- **`from`** — ST-50 IP (string) or list of IPs sharing one name/printer.
- **`name`** — folder under `captured_jobs/` (letters, numbers, dashes, underscores).
- **`printerHost`** — Xerox (or other) IP for jobs from that ST-50.
- Top-level **`printerHost`** — used for unmapped clients and as default when a source omits `printerHost`.

Example capture path:

```
captured_jobs/
  st50-line1/
    1392B-10/
      lot_002/
        RIGHT/
          job_….ps
  st50-line2/
    …
```

Clients not listed in `sources` still forward to the default `printerHost` and save under
`captured_jobs/_unmapped/<client-ip>/…`.

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

**Option A — manual (testing):** Double-click `start-proxy.bat`, or run:

```
node proxy.js
```

**Option B — Windows Service (runs at boot):** Install globally once:

```
npm install -g qckwinsvc
```

From the `print-server` folder, open **Command Prompt as Administrator** (not PowerShell — `sc` conflicts there). Use **non-interactive** flags so uninstall does not re-prompt for install settings:

```
cd /d C:\xampp\git-htdocs\print-server
```

**Install** (letters and dashes only in `--name`; no spaces):

```
qckwinsvc --name Printer-Server-Intercept --description "Print proxy on port 9100" --script C:\xampp\git-htdocs\print-server\proxy.js --startImmediately y
```

**Uninstall** (must pass the same `--name` and `--script` as install):

```
qckwinsvc --uninstall --name Printer-Server-Intercept --script C:\xampp\git-htdocs\print-server\proxy.js
```

The installer creates a `daemon\` folder with logs. Check status:

```
sc.exe query printerserverintercept.exe
```

Logs: `daemon\printerserverintercept.out.log` and `.err.log`.

**Do not run `start-proxy.bat` or `node proxy.js` while the service is running** — both bind port 9100 and the second instance will fail with “Port 9100 is already in use.”

Optional — restart the service process if it crashes (run once after install):

```
sc.exe failure printerserverintercept.exe reset= 86400 actions= restart/60000/restart/60000/restart/60000
```

(A harmless `padLevels` warning from `qckwinsvc` can be ignored.)

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
| `resend.js` | Manually re-send a captured `.ps` file to the printer |
| `convert-to-ps.js` | Convert PDF / DOCX / CSV → PostScript |
| `print-document.js` | Convert (if needed) and print to a `config.json` printer target |
| `csv-to-ps.js` | Built-in CSV → PostScript (fallback without LibreOffice) |
| `printer-targets.js` | Printer list + JetDirect send (shared with PHP app) |
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

If you need to re-print a saved job from the command line:

```
node resend.js captured_jobs\job_20240518_143022.ps
node resend.js captured_jobs\job_20240518_143022.ps --printer default
node resend.js --list-printers
```

Printer targets come from `config.json` (`printerHost` and optional `sources[].printerHost`).
The same target IDs are used by the MegaFood pressing app **Job Browser** (Print button on each CSV).

| Target id | Meaning |
|-----------|---------|
| `default` | Top-level `printerHost` / `printerPort` |
| `source:<name>` | Printer for that `sources[].name` entry |

When `autoConvert` is on, CSV files live under `converted/` next to the `.ps` capture.
Re-print always sends the **`.ps`** bytes (not the CSV), matching the original ST-50 → proxy → printer stream.

---

## Printing PDF / DOCX / CSV (convert → PostScript → printer)

The Xerox B310 expects **PostScript on port 9100**. Use these tools to convert application
documents and send them to any printer target in `config.json` (same as ST-50 forwarding).

### Requirements

| Tool | Used for |
|------|----------|
| [Ghostscript](https://ghostscript.com/releases/gsdnld.html) (`gswin64c`) | PDF → PS (required for PDF); also DOCX→PDF→PS on Windows |
| [LibreOffice](https://www.libreoffice.org/) (`soffice`) | DOCX / CSV / PDF → PS (optional but recommended) |
| Microsoft Word | Windows fallback: DOCX → PDF when LibreOffice is not installed |

Auto-detection looks in PATH and standard install folders. Override paths in `config.json`:

```json
"convertToPs": {
  "tempDir": "./temp/print_jobs",
  "ghostscriptPath": "",
  "libreOfficePath": "",
  "wordComEnabled": true
}
```

### Command line

```
run-convert-to-ps.bat C:\path\report.pdf
run-print-document.bat C:\path\first_piece.docx --printer source:MFG
run-print-document.bat C:\path\data.csv --printer default --json
node print-document.js --list-printers
```

| Format | Conversion path |
|--------|-----------------|
| `.ps` | Passthrough (no conversion) |
| `.pdf` | Ghostscript `ps2write` |
| `.docx` | LibreOffice → PS, or Word COM → PDF → Ghostscript |
| `.csv` | LibreOffice → PS, or built-in `csv-to-ps.js` table layout |

The MegaFood pressing PHP app calls `print-document.js` automatically via `PrinterService`
when Node.js and the print-server folder are available (`PRINT_SERVER_PATH`).

---

## Config options

| Option | Default | Description |
|--------|---------|-------------|
| `listenPort` | `9100` | Port this proxy listens on |
| `printerHost` | — | Default Xerox IP (and fallback for unmapped clients) |
| `printerPort` | `9100` | Xerox port (rarely needs changing) |
| `sources` | `[]` | Per–ST-50 routes: `name`, `from` (IP), `printerHost` (optional `printerPort`) |
| `unmappedSourceFolder` | `_unmapped` | Subfolder under `outputDir` for clients not in `sources` |
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
| `convertToPs` | see above | Paths and temp dir for PDF/DOCX/CSV → PS printing |

---

## Troubleshooting

**Port 9100 already in use**
> Windows Print Spooler can claim port 9100. Open Services (services.msc),
> find "Print Spooler", stop it, and set it to Manual — or change `listenPort`
> to 9101 and update the ST-50 accordingly.
>
> If you installed the Windows service, also stop any manual `node proxy.js`
> (or `start-proxy.bat`) and restart only the service. See `daemon\*.err.log`.

**Windows service installed but proxy not listening**
> `sc query Printer-Server-Intercept` should show `RUNNING`.
> Read `daemon\printerserverintercept.err.log` for bind errors.
> Confirm `config.json` and `proxy.js` paths in `daemon\printerserverintercept.xml`
> point at this folder (reinstall with `qckwinsvc` if you moved the project).

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
