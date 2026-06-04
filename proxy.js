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
const { convertFile } = require("./convert-ps");
const { resolveJobPaths, formatMetaLog } = require("./job-meta");
const {
  isPrinterConfigured,
  resolveConnectionContext,
  formatRouteLabel,
  listSourceRoutes,
} = require("./source-routing");

// ─── Configuration ────────────────────────────────────────────────────────────

const CONFIG_FILE = path.join(__dirname, "config.json");

const DEFAULT_CONFIG = {
  listenPort: 9100,           // Port this proxy listens on
  printerHost: "192.168.1.X", // ← Replace with your Xerox B310 IP
  printerPort: 9100,          // Xerox raw print port (almost always 9100)
  mode: "transparent",        // "transparent" = pipe ST-50 ↔ printer (like a cable)
                              // "capture" = buffer, optional PJL handling, then forward
  outputDir: "./captured_jobs",
  organizeByJobMeta: true,    // product / lot / press folders from PJL JOB NAME
  storagePathTemplate: "{productId}/lot_{lot}/{side}",
  captureJobs: true,          // In transparent mode: save ST-50→printer bytes on close
  autoConvert: false,         // After capture: write CSV/TXT/JSON via convert-ps.js
  autoConvertForm: false,     // Legacy: merge columns (off = 1:1 cell grid, recommended)
  autoConvertDir: "converted", // Subfolder next to each .ps job (in same lot/press folder)
  forwardToPrinter: true,     // capture mode only: forward after buffering
  relayPjlToPrinter: true,    // capture mode only: PJL probe relay
  logLevel: "verbose",        // "verbose" | "normal" | "quiet"
  // Optional per–ST-50 routing (see README). When set, captures go to
  // outputDir/<name>/… and each source can use its own printerHost.
  sources: [],
  unmappedSourceFolder: "_unmapped",
  // Document → PostScript for programmatic printing (see convert-to-ps.js, print-document.js)
  convertToPs: {
    tempDir: "./temp/print_jobs",
    ghostscriptPath: "",
    libreOfficePath: "",
    wordComEnabled: true,
  },
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

function maybeAutoConvert(jobFile, cfg) {
  if (!cfg.autoConvert) return;

  try {
    const raw = fs.readFileSync(jobFile);
    if (raw.indexOf("%!PS") < 0) {
      log("verbose", `  Auto-convert skipped (not PostScript): ${jobFile}`);
      return;
    }

    const convertSub = cfg.autoConvertDir ?? "converted";
    const outDir = path.isAbsolute(convertSub)
      ? convertSub
      : path.join(path.dirname(jobFile), convertSub);

    const result = convertFile(jobFile, outDir);
    log("normal", `  Auto-converted → ${result.csvPath} (${result.rowCount} rows)`);
  } catch (err) {
    log("normal", `  Auto-convert failed: ${err.message}`);
  }
}

function saveCapturedJob(data, cfg) {
  if (isPjlProbeOnly(data)) {
    log("verbose", `  Capture skipped (PJL probe only, not a print job)`);
    return null;
  }

  const { meta, jobFile, storageDir } = resolveJobPaths(data, cfg);
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(jobFile, data);
  log("normal", `  Captured → ${jobFile}`);
  log("normal", `  (${formatMetaLog(meta)})`);
  maybeAutoConvert(jobFile, cfg);
  return jobFile;
}

// ─── PJL probe responses (ST-50 / embedded devices often query before printing) ─

const CRLF = "\r\n";

const PJL_FORM_FEED = "\x0c";

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

// One PJL relay at a time — rapid ST-50 probes can confuse the printer otherwise.
let pjlRelayChain = Promise.resolve();

function enqueuePjlRelay(data, cfg) {
  const run = () => relayPjlToPrinter(data, cfg);
  const next = pjlRelayChain.then(run, run);
  pjlRelayChain = next.catch(() => {});
  return next;
}

function buildCannedPjlReply(data) {
  const text = data.toString("latin1");
  const parts = [];
  for (const { match, body } of PJL_RESPONSES) {
    if (match.test(text)) parts.push(body);
  }
  if (!parts.length) return Buffer.alloc(0);
  return formatPjlReplyForClient(data, Buffer.from(parts.join("") + PJL_FORM_FEED, "latin1"));
}

/** Xerox answers plain @PJL lines; ST-50 sends HP UEL wrappers. */
function normalizePjlForPrinter(data) {
  const text = data.toString("latin1");
  const lines = [];
  for (const m of text.matchAll(/@PJL\s+[^\r\n]+/gi)) {
    const cmd = m[0].trim();
    if (/^@PJL$/i.test(cmd)) continue;
    lines.push(cmd + CRLF);
  }
  if (lines.length) return Buffer.from(lines.join(""), "latin1");
  return data;
}

function requestUsesUel(data) {
  return /\x1B%-12345X/i.test(data.toString("latin1"));
}

/** ST-50 probe ends with ESC%-12345X@PJL — Xerox often closes with ESC%-12345X only. */
function requestHasBarePjlTrailer(data) {
  return /\x1B%-12345X@PJL\s*\r?\n$/i.test(data.toString("latin1"));
}

function describePjlProbe(data) {
  const text = data.toString("latin1");
  const parts = [];
  if (/@PJL\s+INFO\s+ID\b/i.test(text)) parts.push("INFO ID");
  if (/@PJL\s+INFO\s+STATUS\b/i.test(text)) parts.push("INFO STATUS");
  if (/@PJL\s+INFO\s+CONFIG\b/i.test(text)) parts.push("INFO CONFIG");
  if (requestHasBarePjlTrailer(data)) parts.push("UEL+@PJL trailer");
  return parts.length ? parts.join(", ") : "PJL (unknown command)";
}

function alignReplyClosingUel(request, reply) {
  if (!requestHasBarePjlTrailer(request)) return reply;
  let text = reply.toString("latin1");
  if (!/\x1B%-12345X/i.test(text)) return reply;
  if (/\x1B%-12345X@PJL\s*\r?\n$/i.test(text)) return reply;
  text = text.replace(/\x1B%-12345X(\s*\r?\n)+$/, "\x1B%-12345X@PJL\r\n");
  return Buffer.from(text, "latin1");
}

function formatPjlReplyForClient(request, reply) {
  if (!reply || reply.length === 0) return reply;
  let out = reply;
  if (requestUsesUel(request)) {
    const body = reply.toString("latin1");
    if (!/\x1B%-12345X/i.test(body)) {
      out = Buffer.from(`\x1B%-12345X${body}\x1B%-12345X\r\n`, "latin1");
    }
  }
  return alignReplyClosingUel(request, out);
}

/** ST-50 sends UEL-wrapped probes; wait for the full message before replying. */
function isPjlProbeComplete(data) {
  if (data.length === 0 || data.length >= 2048) return false;
  const text = data.toString("latin1");
  if (!/@PJL/i.test(text) || /%!PS/.test(text) || /@PJL\s+JOB\b/i.test(text)) {
    return false;
  }
  // ST-50: ESC%-12345X@PJL INFO STATUS … ESC%-12345X@PJL\r\n
  if (/@PJL\s+INFO\b/i.test(text) && /\x1B%-12345X@PJL\s*\r?\n$/i.test(text)) {
    return true;
  }
  // Single-line @PJL INFO …\r\n
  if (/@PJL\s+INFO\s+\w+[^\r\n]*\r?\n$/i.test(text)) return true;
  return false;
}

function formatBytes(buf, max = 128) {
  const slice = buf.slice(0, max);
  const hex = [...slice].map((b) => b.toString(16).padStart(2, "0")).join(" ");
  const ascii = slice.toString("latin1").replace(/[^\x20-\x7e]/g, ".");
  return `${buf.length} B  hex: ${hex}${buf.length > max ? " …" : ""}\n       ascii: ${ascii}`;
}

function relayPjlToPrinterOnce(payload, cfg) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    const chunks = [];
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      client.destroy();
      if (err) reject(err);
      else resolve(Buffer.concat(chunks));
    };

    client.on("data", (d) => chunks.push(d));

    client.connect(cfg.printerPort, cfg.printerHost, () => {
      client.write(payload, () => {
        setTimeout(() => {
          if (chunks.length === 0) {
            finish(new Error("printer returned no data for PJL probe"));
          } else {
            finish();
          }
        }, 2500);
      });
    });

    client.on("error", (err) => finish(err));
    client.setTimeout(8000, () => finish(new Error("PJL relay timeout")));
  });
}

async function relayPjlToPrinter(data, cfg) {
  const printerReady = isPrinterConfigured(cfg.printerHost);
  if (!printerReady) {
    throw new Error("printerHost not configured");
  }

  const normalized = normalizePjlForPrinter(data);
  const attempts = [];
  if (normalized.length !== data.length || !normalized.equals(data)) {
    attempts.push({ label: "plain @PJL", payload: normalized });
  }
  attempts.push({ label: "as received", payload: data });

  let lastErr;
  for (const { label, payload } of attempts) {
    log("verbose", `  → PJL relay (${payload.length} B, ${label}) to ${cfg.printerHost}:${cfg.printerPort}`);
    try {
      return await relayPjlToPrinterOnce(payload, cfg);
    } catch (err) {
      lastErr = err;
      log("verbose", `  → PJL relay (${label}) failed: ${err.message}`);
    }
  }
  throw lastErr;
}

async function respondToPjlProbe(socket, data, cfg) {
  const text = data.toString("latin1");
  if (!/@PJL/i.test(text)) return false;

  log("normal", `  PJL probe: ${describePjlProbe(data)} (${data.length} B from ST-50)`);

  const writeReply = (reply, label) => {
    if (socket.destroyed || !reply || reply.length === 0) return;
    socket.write(reply);
    log("normal", `  → ${label} (${reply.length} bytes)`);
    log("verbose", `  ${formatBytes(reply)}`);
  };

  if (cfg.relayPjlToPrinter) {
    try {
      const raw = await enqueuePjlRelay(data, cfg);
      const reply = formatPjlReplyForClient(data, raw);
      writeReply(reply, "PJL relay reply from printer");
      return true;
    } catch (err) {
      log("normal", `  PJL relay failed: ${err.message} — using canned reply`);
      const canned = buildCannedPjlReply(data);
      writeReply(canned, "PJL canned reply");
      return canned.length > 0;
    }
  }

  const canned = buildCannedPjlReply(data);
  if (canned.length > 0) {
    writeReply(canned, "PJL canned reply");
    return true;
  }
  return false;
}

// ─── Forward to Printer ───────────────────────────────────────────────────────

function forwardToPrinter(data, cfg) {
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

async function finishJob(socket, chunks, cfg, remote) {
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

    try {
      saveCapturedJob(data, cfg);
    } catch (err) {
      log("normal", `  ERROR saving file: ${err.message}`);
    }

    // ── Forward to printer ──
    if (cfg.forwardToPrinter) {
      const printerReady = isPrinterConfigured(cfg.printerHost);
      if (!printerReady) {
        log("normal", `  Skipping forward — printerHost not configured for this source`);
      } else {
        try {
          await forwardToPrinter(data, cfg);
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

// ─── Transparent relay (ST-50 ↔ printer, byte-for-byte) ─────────────────────

function logConnectionOpen(remote, ctx, mode) {
  const route = formatRouteLabel(ctx);
  const tag = route ? ` source=${route}` : "";
  log("normal", `New connection from ${remote} [${mode}]${tag}`);
  if (ctx.hasSources && !ctx.mapped) {
    log("normal", `  Warning: ${ctx.clientIp} not in config.sources — using default printer, folder ${ctx.config.outputDir}`);
  }
}

function handleTransparent(clientSocket, baseCfg) {
  const remote = `${clientSocket.remoteAddress}:${clientSocket.remotePort}`;
  const ctx = resolveConnectionContext(baseCfg, clientSocket.remoteAddress);
  const cfg = ctx.config;
  const printerReady = isPrinterConfigured(cfg.printerHost);

  logConnectionOpen(remote, ctx, "transparent");

  if (!printerReady) {
    log("normal", `  ERROR: no printerHost for ${ctx.clientIp} (check config.sources or printerHost)`);
    clientSocket.destroy();
    return;
  }

  const printerSocket = new net.Socket();
  const st50ToPrinter = [];
  const printerToSt50 = [];
  let connected = false;
  let pendingToPrinter = [];
  let loggedSt50 = false;
  let loggedPrinter = false;
  let closed = false;

  const finish = () => {
    if (closed) return;
    closed = true;

    const out = Buffer.concat(st50ToPrinter);
    const back = Buffer.concat(printerToSt50);
    log("normal", `  Session done: ST-50→printer ${out.length} B, printer→ST-50 ${back.length} B`);

    if (cfg.captureJobs && out.length > 0) {
      try {
        saveCapturedJob(out, cfg);
      } catch (err) {
        log("normal", `  Capture save error: ${err.message}`);
      }
    }

    printerSocket.destroy();
    clientSocket.destroy();
  };

  clientSocket.on("data", (chunk) => {
    st50ToPrinter.push(chunk);
    if (!loggedSt50) {
      loggedSt50 = true;
      log("normal", `  ST-50 → printer (first chunk):\n       ${formatBytes(chunk)}`);
    }
    if (connected) printerSocket.write(chunk);
    else pendingToPrinter.push(chunk);
  });

  printerSocket.on("data", (chunk) => {
    printerToSt50.push(chunk);
    if (!loggedPrinter) {
      loggedPrinter = true;
      log("normal", `  Printer → ST-50 (first chunk):\n       ${formatBytes(chunk)}`);
    }
    if (!clientSocket.destroyed) clientSocket.write(chunk);
  });

  printerSocket.connect(cfg.printerPort, cfg.printerHost, () => {
    connected = true;
    const via = formatRouteLabel(ctx);
    const label = via ? `${via} (${ctx.clientIp})` : remote;
    log("normal", `  Linked ${label} ↔ ${cfg.printerHost}:${cfg.printerPort}`);
    for (const chunk of pendingToPrinter) printerSocket.write(chunk);
    pendingToPrinter = [];
  });

  printerSocket.on("error", (err) => {
    log("normal", `  Printer connect/IO error: ${err.message}`);
    finish();
  });

  clientSocket.on("error", (err) => {
    log("verbose", `  ST-50 socket error: ${err.message}`);
    finish();
  });

  clientSocket.on("end", () => {
    log("verbose", `  ST-50 sent FIN`);
    if (connected) printerSocket.end();
  });

  printerSocket.on("end", () => log("verbose", `  Printer sent FIN`));

  clientSocket.on("close", finish);
  printerSocket.on("close", finish);
}

function handleJob(socket, baseCfg) {
  const remote = `${socket.remoteAddress}:${socket.remotePort}`;
  const ctx = resolveConnectionContext(baseCfg, socket.remoteAddress);
  const cfg = ctx.config;

  logConnectionOpen(remote, ctx, "capture");

  if (!isPrinterConfigured(cfg.printerHost)) {
    log("normal", `  ERROR: no printerHost for ${ctx.clientIp}`);
    socket.destroy();
    return;
  }

  const chunks = [];
  let pjlResponded = false;
  let pjlInFlight = false;
  let jobHandled = false;
  let pjlIdleTimer = null;
  const PJL_IDLE_MS = 100;

  let loggedFirstBytes = false;

  const schedulePjlCheck = () => {
    clearTimeout(pjlIdleTimer);
    if (pjlResponded || pjlInFlight) return;

    const data = Buffer.concat(chunks);
    if (!/@PJL/i.test(data.toString("latin1"))) return;

    if (isPjlProbeComplete(data)) {
      pjlInFlight = true;
      respondToPjlProbe(socket, data, cfg)
        .then((ok) => {
          if (ok) pjlResponded = true;
        })
        .finally(() => {
          pjlInFlight = false;
        });
      return;
    }

    pjlIdleTimer = setTimeout(() => {
      if (pjlResponded || pjlInFlight) return;
      const buf = Buffer.concat(chunks);
      if (!/@PJL/i.test(buf.toString("latin1"))) return;
      pjlInFlight = true;
      respondToPjlProbe(socket, buf, cfg)
        .then((ok) => {
          if (ok) pjlResponded = true;
        })
        .finally(() => {
          pjlInFlight = false;
        });
    }, PJL_IDLE_MS);
  };

  socket.on("data", (chunk) => {
    chunks.push(chunk);
    if (!loggedFirstBytes) {
      loggedFirstBytes = true;
      log("normal", `  First bytes from ${remote}:\n       ${formatBytes(chunk)}`);
    } else {
      log("verbose", `  Received chunk: ${chunk.length} bytes`);
    }
    schedulePjlCheck();
  });

  const onJobClosed = async () => {
    if (jobHandled) return;
    jobHandled = true;
    clearTimeout(pjlIdleTimer);

    const data = Buffer.concat(chunks);
    if (data.length === 0) {
      log("verbose", `  Connection closed with no data from ${remote}`);
      return;
    }
    if (isPjlProbeOnly(data)) {
      if (!pjlResponded && !pjlInFlight) {
        await respondToPjlProbe(socket, data, cfg);
        pjlResponded = true;
      } else if (pjlInFlight) {
        await pjlRelayChain;
      }
      log("normal", `  PJL probe from ${remote} (${data.length} bytes, responded)`);
      return;
    }
    await finishJob(socket, chunks, cfg, remote);
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
  log("normal", `Printer IP    : ${cfg.printerHost}${listSourceRoutes(cfg).length ? " (default / unmapped)" : ""}`);
  log("normal", `Printer port  : ${cfg.printerPort}`);
  log("normal", `Output dir    : ${path.resolve(cfg.outputDir)}`);
  const routes = listSourceRoutes(cfg);
  if (routes.length) {
    log("normal", `Source routes : ${routes.length} mapped client(s)`);
    for (const r of routes) {
      log("normal", `  ${r.name.padEnd(16)} ${r.ip} → ${r.printerHost}:${r.printerPort}`);
    }
    log("normal", `  (captures under ${path.resolve(cfg.outputDir)}<name>/…)`);
  }
  if (cfg.organizeByJobMeta) {
    const under = routes.length ? "<name>/" : "";
    log("normal", `Storage layout: ${under}${cfg.storagePathTemplate || "{productId}/lot_{lot}/{side}"}`);
  }
  const mode = (cfg.mode || "transparent").toLowerCase();
  log("normal", `Mode          : ${mode}${mode === "transparent" ? " (pipe ST-50 ↔ printer)" : " (buffer + PJL handling)"}`);
  if (mode === "capture") {
    log("normal", `Forwarding    : ${cfg.forwardToPrinter ? "ENABLED" : "DISABLED"}`);
    log("normal", `PJL relay     : ${cfg.relayPjlToPrinter ? "ENABLED" : "DISABLED"}`);
  } else {
    log("normal", `Capture jobs  : ${cfg.captureJobs ? "ENABLED" : "DISABLED"}`);
    log("normal", `Auto-convert  : ${cfg.autoConvert ? `ENABLED → ${cfg.autoConvertDir}` : "DISABLED"}`);
    if (cfg.autoConvert) {
      log("normal", `  Grid layout   : ${cfg.autoConvertForm ? "legacy label,value merge" : "1:1 table cells"}`);
    }
  }
  log("normal", `Log level     : ${cfg.logLevel}`);
  log("normal", "─".repeat(60));

  const server = net.createServer((socket) => {
    if (mode === "transparent") handleTransparent(socket, cfg);
    else handleJob(socket, cfg);
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
    log("normal", `ST-50 should use THIS PC's IP (not the Xerox IP) on port ${cfg.listenPort}.`);
    if (mode === "transparent") {
      log("normal", `Printer replies pass straight back to the ST-50 — same as a direct cable.`);
    }
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
