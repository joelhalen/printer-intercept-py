/**
 * resend.js — Manually forward a previously captured .ps file to the printer.
 *
 * Usage:
 *   node resend.js <path-to-job.ps>
 *   node resend.js <path-to-job.ps> --printer default
 *   node resend.js <path-to-job.ps> --printer source:st50-line1
 *   node resend.js --list-printers
 */

const fs = require("fs");
const path = require("path");
const { loadConfigFromFile } = require("./printer-config");
const { listPrinterTargets, resolvePrinterTarget, sendToPrinter } = require("./printer-targets");

function parseArgs(argv) {
  const args = argv.slice(2);
  let filePath = null;
  let printerId = null;
  let listOnly = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--list-printers") {
      listOnly = true;
    } else if (a === "--printer" && args[i + 1]) {
      printerId = args[++i];
    } else if (!a.startsWith("-") && !filePath) {
      filePath = a;
    }
  }

  return { filePath, printerId, listOnly };
}

async function main() {
  const cfg = loadConfigFromFile();
  const { filePath, printerId, listOnly } = parseArgs(process.argv);

  if (listOnly) {
    const targets = listPrinterTargets(cfg);
    if (targets.length === 0) {
      console.log("No configured printer targets (set printerHost in config.json).");
      process.exit(1);
    }
    console.log("Available printer targets:");
    for (const t of targets) {
      console.log(`  ${t.id.padEnd(20)} ${t.label}`);
    }
    return;
  }

  if (!filePath) {
    console.error("Usage: node resend.js <path-to-job.ps> [--printer <id>]");
    console.error("       node resend.js --list-printers");
    process.exit(1);
  }

  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`File not found: ${resolved}`);
    process.exit(1);
  }

  const target = resolvePrinterTarget(cfg, printerId);
  if (!target) {
    console.error(printerId ? `Unknown printer id: ${printerId}` : "No printer configured in config.json");
    console.error("Run: node resend.js --list-printers");
    process.exit(1);
  }

  const data = fs.readFileSync(resolved);
  console.log(
    `Sending ${resolved} (${(data.length / 1024).toFixed(1)} KB) → ${target.host}:${target.port} [${target.id}] ...`
  );

  try {
    const result = await sendToPrinter(data, target.host, target.port);
    console.log(`Done. Sent ${result.bytes} bytes.`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
