/**
 * resend.js — Manually forward a previously captured .ps file to the printer.
 *
 * Usage:  node resend.js <path-to-job.ps>
 * Example: node resend.js captured_jobs/job_20240518_143022.ps
 */

const net = require("net");
const fs = require("fs");
const path = require("path");

const CONFIG_FILE = path.join(__dirname, "config.json");

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error("config.json not found. Run proxy.js first to generate it.");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
}

function sendFile(filePath, cfg) {
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const data = fs.readFileSync(filePath);
  console.log(`Sending ${filePath} (${(data.length / 1024).toFixed(1)} KB) to ${cfg.printerHost}:${cfg.printerPort} ...`);

  const client = new net.Socket();

  client.connect(cfg.printerPort, cfg.printerHost, () => {
    console.log("Connected to printer.");
    client.write(data, () => {
      client.end();
    });
  });

  client.on("data", (d) => {
    console.log(`Printer response: ${d.length} bytes`);
  });

  client.on("close", () => {
    console.log("Done. Job sent successfully.");
  });

  client.on("error", (err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });

  client.setTimeout(10000, () => {
    console.error("Connection timed out.");
    client.destroy();
    process.exit(1);
  });
}

const arg = process.argv[2];
if (!arg) {
  console.error("Usage: node resend.js <path-to-job.ps>");
  process.exit(1);
}

const cfg = loadConfig();
sendFile(path.resolve(arg), cfg);
