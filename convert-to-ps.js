/**
 * Convert PDF, DOCX, or CSV to PostScript for JetDirect printing.
 *
 * Usage:
 *   node convert-to-ps.js document.pdf
 *   node convert-to-ps.js report.docx -o output.ps
 *   node convert-to-ps.js data.csv --json
 */

const fs = require("fs");
const path = require("path");
const { loadConfigFromFile } = require("./printer-config");
const {
  mergeConvertConfig,
  ensureDir,
  findGhostscript,
  findLibreOffice,
  convertPdfViaGhostscript,
  convertViaLibreOffice,
  convertDocxViaWordPdf,
} = require("./convert-tools");
const { writeCsvAsPostScript } = require("./csv-to-ps");

const SUPPORTED = new Set(["ps", "pdf", "docx", "csv"]);

function detectType(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (SUPPORTED.has(ext)) return ext;
  const head = fs.readFileSync(filePath).slice(0, 8).toString("latin1");
  if (head.startsWith("%!PS")) return "ps";
  if (head.startsWith("%PDF")) return "pdf";
  if (head.startsWith("PK")) return "docx";
  return "unknown";
}

function defaultOutputPath(inputPath, tempDir) {
  const root = path.resolve(tempDir);
  ensureDir(root);
  const base = path.basename(inputPath, path.extname(inputPath));
  return path.join(root, `${base}_${Date.now()}.ps`);
}

function isValidPs(filePath) {
  const head = fs.readFileSync(filePath).slice(0, 4).toString("ascii");
  return head === "%!PS" || head.startsWith("%!P");
}

/**
 * @param {string} inputPath
 * @param {{ outputPath?: string, config?: object }} [options]
 * @returns {{ outputPath: string, method: string, inputType: string, temp: boolean }}
 */
function convertDocumentToPs(inputPath, options = {}) {
  const cfg = options.config || loadConfigFromFile();
  const ccfg = mergeConvertConfig(cfg);
  const resolved = path.resolve(inputPath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }

  const inputType = detectType(resolved);
  if (inputType === "unknown") {
    throw new Error(`Unsupported file type: ${path.extname(resolved) || "(none)"}`);
  }

  const tempDir = path.resolve(ccfg.tempDir);
  const outputPath = options.outputPath
    ? path.resolve(options.outputPath)
    : defaultOutputPath(resolved, tempDir);
  ensureDir(path.dirname(outputPath));

  if (inputType === "ps") {
    if (path.resolve(outputPath) !== resolved) {
      fs.copyFileSync(resolved, outputPath);
    }
    return { outputPath, method: "passthrough", inputType, temp: outputPath !== resolved };
  }

  const gs = findGhostscript(ccfg.ghostscriptPath);
  const lo = findLibreOffice(ccfg.libreOfficePath);
  const workDir = path.join(tempDir, `job_${Date.now()}`);
  ensureDir(workDir);

  let method;
  try {
    if (inputType === "pdf") {
      if (!gs) {
        throw new Error(
          "Ghostscript not found (install from https://ghostscript.com/ or set convertToPs.ghostscriptPath)"
        );
      }
      method = convertPdfViaGhostscript(gs, resolved, outputPath);
    } else if (inputType === "docx") {
      let lastErr = null;
      if (lo) {
        try {
          const out = convertViaLibreOffice(lo, resolved, workDir);
          fs.copyFileSync(out.path, outputPath);
          method = out.method;
        } catch (e) {
          lastErr = e;
        }
      }
      if (!method && ccfg.wordComEnabled && process.platform === "win32" && gs) {
        try {
          const out = convertDocxViaWordPdf(gs, resolved, workDir);
          fs.copyFileSync(out.path, outputPath);
          method = out.method;
        } catch (e) {
          lastErr = lastErr || e;
        }
      }
      if (!method) {
        throw lastErr || new Error("DOCX conversion requires LibreOffice or Word COM + Ghostscript on Windows");
      }
    } else if (inputType === "csv") {
      if (lo) {
        try {
          const out = convertViaLibreOffice(lo, resolved, workDir);
          fs.copyFileSync(out.path, outputPath);
          method = out.method;
        } catch (e) {
          writeCsvAsPostScript(resolved, outputPath);
          method = "csv-native";
        }
      } else {
        writeCsvAsPostScript(resolved, outputPath);
        method = "csv-native";
      }
    }
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  }

  if (!fs.existsSync(outputPath) || !isValidPs(outputPath)) {
    throw new Error(`Conversion produced invalid PostScript: ${outputPath}`);
  }

  return {
    outputPath,
    method,
    inputType,
    temp: !options.outputPath || path.resolve(options.outputPath) !== resolved,
  };
}

function parseCli(argv) {
  const args = argv.slice(2);
  let input = null;
  let output = null;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if ((a === "-o" || a === "--output") && args[i + 1]) output = args[++i];
    else if (!a.startsWith("-") && !input) input = a;
  }
  return { input, output, json };
}

function main() {
  const { input, output, json } = parseCli(process.argv);
  if (!input) {
    console.error("Usage: node convert-to-ps.js <file.pdf|docx|csv|ps> [-o output.ps] [--json]");
    process.exit(1);
  }
  try {
    const result = convertDocumentToPs(input, { outputPath: output || undefined });
    const payload = {
      success: true,
      input: path.resolve(input),
      output: result.outputPath,
      method: result.method,
      inputType: result.inputType,
      bytes: fs.statSync(result.outputPath).size,
    };
    if (json) {
      console.log(JSON.stringify(payload));
    } else {
      console.log(`OK ${result.method} → ${result.outputPath} (${payload.bytes} bytes)`);
    }
  } catch (err) {
    if (json) {
      console.log(JSON.stringify({ success: false, error: err.message }));
    } else {
      console.error(err.message);
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { convertDocumentToPs, detectType, SUPPORTED };
