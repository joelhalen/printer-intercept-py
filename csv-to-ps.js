/**
 * Build a simple PostScript document from a CSV file (tabular report).
 * Used when LibreOffice is not available.
 */

const fs = require("fs");

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN_L = 36;
const MARGIN_T = 756;
const LINE_H = 11;
const FONT_SIZE = 9;
const MAX_COLS = 20;
const MAX_CELL_CHARS = 48;

function escapePsString(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/[^\x20-\x7e]/g, "?");
}

function parseCsvLines(text) {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const rows = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    const cols = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQ = !inQ;
        }
      } else if (ch === "," && !inQ) {
        cols.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    cols.push(cur);
    rows.push(cols.map((c) => c.trim()));
  }
  return rows;
}

/**
 * @param {string} csvPath
 * @returns {string} PostScript source
 */
function csvToPostScript(csvPath) {
  const raw = fs.readFileSync(csvPath, "utf8");
  const rows = parseCsvLines(raw);
  if (rows.length === 0) {
    throw new Error("CSV is empty");
  }

  const colCount = Math.min(
    MAX_COLS,
    rows.reduce((m, r) => Math.max(m, r.length), 0)
  );
  const colWidth = Math.floor((PAGE_W - MARGIN_L * 2) / Math.max(colCount, 1));

  const chunks = [
    "%!PS-Adobe-3.0",
    "%%Title: CSV Print",
    "%%Creator: print-server csv-to-ps",
    "%%Pages: (atend)",
    "%%EndComments",
  ];

  let pageLines = 0;
  const startPage = () => {
    chunks.push("%%Page: 1 1");
    chunks.push("%%BeginPageSetup");
    chunks.push(`${MARGIN_L} ${MARGIN_T} translate`);
    chunks.push("/Courier findfont");
    chunks.push(`${FONT_SIZE} scalefont`);
    chunks.push("setfont");
    chunks.push("%%EndPageSetup");
    pageLines = 0;
  };

  startPage();

  for (const row of rows) {
    if (pageLines > 0 && pageLines * LINE_H > PAGE_H - 72) {
      chunks.push("showpage");
      startPage();
    }
    let x = 0;
    for (let c = 0; c < colCount; c++) {
      let cell = row[c] ?? "";
      if (cell.length > MAX_CELL_CHARS) {
        cell = cell.slice(0, MAX_CELL_CHARS - 1) + "…";
      }
      const y = -pageLines * LINE_H;
      chunks.push(`${x} ${y} moveto`);
      chunks.push(`(${escapePsString(cell)}) show`);
      x += colWidth;
    }
    pageLines++;
  }

  chunks.push("showpage");
  chunks.push("%%Trailer");
  chunks.push("%%EOF");
  return chunks.join("\n") + "\n";
}

/**
 * @param {string} csvPath
 * @param {string} outputPsPath
 */
function writeCsvAsPostScript(csvPath, outputPsPath) {
  const ps = csvToPostScript(csvPath);
  fs.writeFileSync(outputPsPath, ps, "utf8");
  return outputPsPath;
}

module.exports = { csvToPostScript, writeCsvAsPostScript };
