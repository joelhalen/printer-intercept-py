/**
 * SOTAX ST-50 → Print Capture Proxy
 * Listens for raw print jobs on port 9100, saves them to disk,
 * then forwards the data to the real Xerox B310 printer.
 *
 * Usage:  node proxy.js
 * Config: edit config.json (created on first run if missing)
 */

const net = require("net");
const fs = require("fs");
const path = require("path");

// ─── Configuration ────────────────────────────────────────────────────────────

const CONFIG_FILE = path.join(__dirname, "config.json");

const DEFAULT_CONFIG = {
  listenPort: 9100,           // Port this proxy listens on
  printerHost: "192.168.1.X", // ← Replace with your Xerox B310 IP
  printerPort: 9100,          // Xerox raw print port (almost always 9100)
  outputDir: "./captured_jobs",
  forwardToPrinter: true,     // Set false to capture-only (no forwarding)
  logLevel: "verbose",        // "verbose" | "normal" | "quiet"
};

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
    log("normal", `Created default config.json — edit printerHost before use.`);
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  return { ...DEFAULT_CONFIG, ...cfg };
}

// ─── Logging ─────────────────────────────────────────────────────────────────

const LEVELS = { quiet: 0, normal: 1, verbose: 2 };

function log(level, ...args) {
  const cfg = global.__config || DEFAULT_CONFIG;
  if (LEVELS[level] <= LEVELS[cfg.logLevel]) {
    const ts = new Date().toISOString().replace("T", " ").substring(0, 19);
    console.log(`[${ts}] [${level.toUpperCase()}]`, ...args);
  }
}

// ─── Job File Naming ──────────────────────────────────────────────────────────

function makeJobFilename(outputDir) {
  const now = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "_",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
  const filename = `job_${stamp}.ps`;
  return path.join(outputDir, filename);
}

// ─── PJL probe responses (ST-50 / embedded devices often query before printing) ─

const CRLF = "\r\n";

const PJL_RESPONSES = [
  {
    match: /@PJL\s+INFO\s+ID\b/i,
    body: `@PJL INFO ID${CRLF}"PostScript Printer"${CRLF}`,
  },
  {
    match: /@PJL\s+INFO\s+STATUS\b/i,
    body: [
      `@PJL INFO STATUS`,
      `CODE=10001`,
      `DISPLAY="Ready"`,
      `ONLINE=TRUE`,
      "",
    ].join(CRLF),
  },
  {
    match: /@PJL\s+INFO\s+CONFIG\b/i,
    body: `@PJL INFO CONFIG${CRLF}LANGUAGE=POSTSCRIPT${CRLF}`,
  },
];

function handlePjlProbes(socket, chunk, responded) {
  const text = chunk.toString("latin1");
  let any = false;
  for (const { match, body } of PJL_RESPONSES) {
    if (match.test(text)) {
      socket.write(body);
      log("verbose", `  → PJL response sent for ${match}`);
      any = true;
    }
  }
  return any || responded;
}

// ─── Forward to Printer ───────────────────────────────────────────────────────

function forwardToPrinter(data, cfg, jobFile) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    let forwarded = 0;

    client.connect(cfg.printerPort, cfg.printerHost, () => {
      log("verbose", `  → Connected to printer ${cfg.printerHost}:${cfg.printerPort}`);
      client.write(data, (err) => {
        if (err) return reject(err);
        forwarded = data.length;
        client.end(); // graceful close after write
      });
    });

    client.on("data", (d) => {
      // Printers sometimes send back status bytes — log but ignore
      log("verbose", `  ← Printer response: ${d.length} bytes`);
    });

    client.on("close", () => {
      log("normal", `  Forwarded ${forwarded} bytes to printer. Done.`);
      resolve();
    });

    client.on("error", (err) => {
      log("normal", `  Printer forward error: ${err.message}`);
      reject(err);
    });

    client.setTimeout(10000, () => {
      log("normal", `  Printer connection timed out.`);
      client.destroy();
      reject(new Error("Printer connection timeout"));
    });
  });
}

// ─── Handle One Incoming Print Job ───────────────────────────────────────────

async function finishJob(socket, chunks, cfg, remote, jobFile) {
    const data = Buffer.concat(chunks);
    const totalKB = (data.length / 1024).toFixed(1);
    log("normal", `Job complete: ${data.length} bytes (${totalKB} KB) from ${remote}`);

    // ── Detect whether it's actually PostScript ──
    const header = data.slice(0, 4).toString("ascii");
    if (header === "%!PS") {
      log("verbose", `  Detected PostScript header (%!PS) ✓`);
    } else {
      log("normal", `  Warning: no %!PS header found (got: ${JSON.stringify(header)}) — may be PCL or binary`);
    }

    // ── Save to disk ──
    try {
      fs.writeFileSync(jobFile, data);
      log("normal", `  Saved → ${jobFile}`);
    } catch (err) {
      log("normal", `  ERROR saving file: ${err.message}`);
    }

    // ── Forward to printer ──
    if (cfg.forwardToPrinter) {
      const printerReady = cfg.printerHost && cfg.printerHost !== "192.168.1.X";
      if (!printerReady) {
        log("normal", `  Skipping forward — printerHost not configured in config.json`);
      } else {
        try {
          await forwardToPrinter(data, cfg, jobFile);
        } catch (err) {
          log("normal", `  Forward failed: ${err.message}`);
        }
      }
    } else {
      log("verbose", `  Forwarding disabled (forwardToPrinter: false)`);
    }
}

function isPjlProbeOnly(data) {
  if (data.length >= 2048) return false;
  const text = data.toString("latin1");
  if (/%!PS/.test(text)) return false;
  if (/@PJL\s+JOB\b/i.test(text)) return false;
  return /@PJL\s+INFO\b/i.test(text);
}

function handleJob(socket, cfg) {
  const remote = `${socket.remoteAddress}:${socket.remotePort}`;
  log("normal", `New connection from ${remote}`);

  const chunks = [];
  const jobFile = makeJobFilename(cfg.outputDir);
  let pjlResponded = false;
  let jobHandled = false;

  socket.on("data", (chunk) => {
    chunks.push(chunk);
    log("verbose", `  Received chunk: ${chunk.length} bytes`);
    pjlResponded = handlePjlProbes(socket, chunk, pjlResponded);
  });

  const onJobClosed = async () => {
    if (jobHandled) return;
    jobHandled = true;

    const data = Buffer.concat(chunks);
    if (data.length === 0) {
      log("verbose", `  Connection closed with no data from ${remote}`);
      return;
    }
    if (isPjlProbeOnly(data)) {
      log("normal", `  PJL probe from ${remote} (${data.length} bytes, responded)`);
      return;
    }
    await finishJob(socket, chunks, cfg, remote, jobFile);
  };

  socket.on("end", () => {
    onJobClosed().catch((err) => log("normal", `  Job handler error: ${err.message}`));
  });

  socket.on("error", (err) => {
    log("normal", `Socket error from ${remote}: ${err.message}`);
  });

  socket.on("close", () => {
    log("verbose", `Connection closed from ${remote}`);
    if (!jobHandled && chunks.length > 0) {
      onJobClosed().catch((err) => log("normal", `  Job handler error: ${err.message}`));
    }
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const cfg = loadConfig();
  global.__config = cfg;

  // Ensure output directory exists
  if (!fs.existsSync(cfg.outputDir)) {
    fs.mkdirSync(cfg.outputDir, { recursive: true });
    log("normal", `Created output directory: ${cfg.outputDir}`);
  }

  log("normal", "─".repeat(60));
  log("normal", "SOTAX ST-50 Print Capture Proxy");
  log("normal", "─".repeat(60));
  log("normal", `Listen port   : ${cfg.listenPort}`);
  log("normal", `Printer IP    : ${cfg.printerHost}`);
  log("normal", `Printer port  : ${cfg.printerPort}`);
  log("normal", `Output dir    : ${path.resolve(cfg.outputDir)}`);
  log("normal", `Forwarding    : ${cfg.forwardToPrinter ? "ENABLED" : "DISABLED"}`);
  log("normal", `Log level     : ${cfg.logLevel}`);
  log("normal", "─".repeat(60));

  const server = net.createServer((socket) => {
    handleJob(socket, cfg);
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\nERROR: Port ${cfg.listenPort} is already in use.`);
      console.error(`  → Another print service may be running (e.g. Windows Print Spooler on 9100).`);
      console.error(`  → Try changing listenPort in config.json, or stop the conflicting service.\n`);
    } else {
      console.error(`Server error: ${err.message}`);
    }
    process.exit(1);
  });

  server.listen(cfg.listenPort, "0.0.0.0", () => {
    log("normal", `Proxy listening on 0.0.0.0:${cfg.listenPort} — ready for jobs.`);
    log("normal", `Enter this machine's IP into the ST-50 as the printer address.`);
  });

  // Graceful shutdown
  process.on("SIGINT", () => {
    log("normal", "\nShutting down proxy...");
    server.close(() => {
      log("normal", "Server closed.");
      process.exit(0);
    });
  });
}

main();
