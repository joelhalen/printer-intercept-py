/**
 * Convert a document to PostScript and send it to a configured printer target.
 *
 * Usage:
 *   node print-document.js <file.pdf|docx|csv|ps> [--printer default]
 *   node print-document.js report.pdf --printer source:MFG --json
 *   node print-document.js --list-printers
 */

const fs = require("fs");
const path = require("path");
const { loadConfigFromFile } = require("./printer-config");
const { convertDocumentToPs } = require("./convert-to-ps");
const { listPrinterTargets, resolvePrinterTarget, sendToPrinter } = require("./printer-targets");

function parseArgs(argv) {
  const args = argv.slice(2);
  let filePath = null;
  let printerId = null;
  let listOnly = false;
  let json = false;
  let keepPs = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--list-printers") listOnly = true;
    else if (a === "--json") json = true;
    else if (a === "--keep-ps") keepPs = true;
    else if (a === "--printer" && args[i + 1]) printerId = args[++i];
    else if (!a.startsWith("-") && !filePath) filePath = a;
  }
  return { filePath, printerId, listOnly, json, keepPs };
}

function emit(obj, json) {
  if (json) {
    console.log(JSON.stringify(obj));
  } else if (obj.success) {
    console.log(obj.message || "Done.");
  } else {
    console.error(obj.error || "Failed.");
  }
}

async function main() {
  const cfg = loadConfigFromFile();
  const { filePath, printerId, listOnly, json, keepPs } = parseArgs(process.argv);

  if (listOnly) {
    const targets = listPrinterTargets(cfg);
    if (json) {
      emit({ success: true, printers: targets }, true);
    } else {
      for (const t of targets) {
        console.log(`${t.id.padEnd(20)} ${t.label}`);
      }
    }
    return;
  }

  if (!filePath) {
    console.error("Usage: node print-document.js <file> [--printer <id>] [--json] [--keep-ps]");
    process.exit(1);
  }

  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    emit({ success: false, error: `File not found: ${resolved}` }, json);
    process.exit(1);
  }

  const target = resolvePrinterTarget(cfg, printerId);
  if (!target) {
    emit({ success: false, error: "No printer target configured" }, json);
    process.exit(1);
  }

  try {
    const converted = convertDocumentToPs(resolved, { config: cfg });
    const data = fs.readFileSync(converted.outputPath);
    const result = await sendToPrinter(data, target.host, target.port);

    if (converted.temp && !keepPs) {
      try {
        fs.unlinkSync(converted.outputPath);
      } catch (_) {
        /* ignore */
      }
    }

    emit(
      {
        success: true,
        message: `Sent ${result.bytes} bytes to ${target.host}:${target.port} (${target.id})`,
        input: resolved,
        inputType: converted.inputType,
        convertMethod: converted.method,
        printer: target,
        bytes: result.bytes,
        psPath: keepPs ? converted.outputPath : null,
      },
      json
    );
  } catch (err) {
    emit({ success: false, error: err.message }, json);
    process.exit(1);
  }
}

main();
