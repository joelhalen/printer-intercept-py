/**
 * Convert SOTAX ST-50 PostScript printouts to CSV / plain text.
 *
 * ST-50 draws each table cell as a rectangle, then places (text)show inside it.
 * We parse those rectangles for a 1:1 grid match to the printed report.
 *
 * Usage:
 *   node convert-ps.js captured_jobs\job.ps
 *   node convert-ps.js captured_jobs
 */

const fs = require("fs");
const path = require("path");

const BAND_TOL = 2;
const RECT_RE =
  /newpath\s+([\d.]+)\s+([\d.]+)\s+moveto\s+([\d.]+)\s+([\d.]+)\s+lineto\s+([\d.]+)\s+([\d.]+)\s+lineto\s+([\d.]+)\s+([\d.]+)\s+lineto\s+([\d.]+)\s+([\d.]+)\s+lineto/g;

function extractPostScript(raw) {
  const text =
    typeof raw === "string" ? raw : raw.toString("latin1");
  const idx = text.indexOf("%!PS");
  if (idx < 0) throw new Error("No PostScript header (%!PS) found");
  return text.slice(idx);
}

function decodePsString(s) {
  return s.replace(/\\(.)/g, (_, c) => {
    if (c === "n") return "\n";
    if (c === "r") return "\r";
    if (c === "t") return "\t";
    return c;
  });
}

/** ST-50 table cells: axis-aligned rects from newpath … lineto×4 … closepath */
function parseRectangles(ps) {
  const seen = new Map();
  const rects = [];
  let m;
  while ((m = RECT_RE.exec(ps)) !== null) {
    const xs = [m[1], m[3], m[5], m[7], m[9]].map(parseFloat);
    const ys = [m[2], m[4], m[6], m[8], m[10]].map(parseFloat);
    const xmin = Math.min(...xs);
    const xmax = Math.max(...xs);
    const ymin = Math.min(...ys);
    const ymax = Math.max(...ys);
    const w = xmax - xmin;
    const h = ymax - ymin;
    if (w < 30 || h < 8 || h > 30) continue;

    const key = [xmin, ymin, xmax, ymax]
      .map((v) => Math.round(v * 2) / 2)
      .join("|");
    if (seen.has(key)) continue;
    seen.set(key, true);
    rects.push({ xmin, xmax, ymin, ymax });
  }
  return rects;
}

function parseTextPlacements(ps) {
  const texts = [];
  const showRe = /\((?:\\.|[^\\)])*\)\s*show/g;
  const movetoRe = /([\d.]+)\s+([\d.]+)\s+moveto/g;
  let m;

  while ((m = showRe.exec(ps)) !== null) {
    const literal = m[0].match(/\((?:\\.|[^\\)])*\)/);
    if (!literal) continue;

    const before = ps.slice(Math.max(0, m.index - 500), m.index);
    const movetos = [...before.matchAll(movetoRe)];
    if (!movetos.length) continue;

    const last = movetos[movetos.length - 1];
    texts.push({
      x: parseFloat(last[1]),
      y: parseFloat(last[2]),
      text: decodePsString(literal[0].slice(1, -1)),
    });
  }
  return texts;
}

function clusterAxis(values, tolerance) {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  if (!sorted.length) return [];
  const groups = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const v = sorted[i];
    const last = groups[groups.length - 1];
    if (v - last[last.length - 1] <= tolerance) last.push(v);
    else groups.push([v]);
  }
  return groups.map((g) => g.reduce((a, b) => a + b, 0) / g.length);
}

function bandIndex(value, bands) {
  let best = 0;
  let dist = Math.abs(value - bands[0]);
  for (let i = 1; i < bands.length; i++) {
    const d = Math.abs(value - bands[i]);
    if (d < dist) {
      dist = d;
      best = i;
    }
  }
  return best;
}

function findCellForPoint(x, y, rects) {
  const margin = 0.35;
  let hits = rects.filter(
    (c) =>
      x >= c.xmin + margin &&
      x <= c.xmax - margin &&
      y >= c.ymin + margin &&
      y <= c.ymax - margin
  );
  if (!hits.length) {
    hits = rects.filter(
      (c) => x >= c.xmin && x <= c.xmax && y >= c.ymin && y <= c.ymax
    );
  }
  if (!hits.length) return null;
  return hits.sort((a, b) => {
    const areaA = (a.xmax - a.xmin) * (a.ymax - a.ymin);
    const areaB = (b.xmax - b.xmin) * (b.ymax - b.ymin);
    return areaA - areaB;
  })[0];
}

/** Build grid from drawn cell boundaries (1:1 with printed table). */
function buildGridFromRectangles(rects, texts) {
  if (!rects.length) return { rows: [], colCount: 0 };

  const rowBands = clusterAxis(
    rects.map((r) => r.ymin),
    BAND_TOL
  );
  const colBands = clusterAxis(
    rects.map((r) => r.xmin),
    BAND_TOL
  );

  const grid = Array.from({ length: rowBands.length }, () =>
    Array(colBands.length).fill("")
  );

  for (const t of texts) {
    if (!t.text.trim()) continue;
    const cell = findCellForPoint(t.x, t.y, rects);
    if (!cell) continue;
    const ri = bandIndex(cell.ymin, rowBands);
    const ci = bandIndex(cell.xmin, colBands);
    if (!grid[ri][ci]) grid[ri][ci] = t.text;
  }

  const rows = grid
    .map((row) => row.map((c) => String(c).trim()))
    .filter((row) => row.some((c) => c !== ""));

  return { rows, colCount: colBands.length, rowBands: rowBands.length };
}

function escapeCsv(field) {
  const s = String(field ?? "");
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows) {
  const maxCols = rows.reduce((n, r) => Math.max(n, r.length), 0);
  const padded = rows.map((r) => {
    const copy = [...r];
    while (copy.length < maxCols) copy.push("");
    return copy;
  });
  return padded.map((row) => row.map(escapeCsv).join(",")).join("\r\n");
}

function toText(rows) {
  if (!rows.length) return "";
  const maxCols = rows.reduce((n, r) => Math.max(n, r.length), 0);
  const widths = Array(maxCols).fill(0);
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i], String(cell).length);
    });
  }
  return rows
    .map((row) => {
      const cells = [];
      for (let i = 0; i < maxCols; i++) {
        cells.push(String(row[i] ?? "").padEnd(widths[i]));
      }
      return cells.join("  ");
    })
    .join("\n");
}

function splitPages(ps) {
  const parts = ps.split(/%%Page:\s*/);
  if (parts.length <= 1) return [{ num: 1, body: ps }];
  return parts.slice(1).map((chunk, i) => {
    const nl = chunk.indexOf("\n");
    const header = nl >= 0 ? chunk.slice(0, nl).trim() : `page ${i + 1}`;
    return { num: i + 1, header, body: chunk };
  });
}

function convertPage(pageBody) {
  const rects = parseRectangles(pageBody);
  const texts = parseTextPlacements(pageBody);
  return buildGridFromRectangles(rects, texts);
}

function convertPostScript(ps, options = {}) {
  const pages = splitPages(ps);
  let totalTexts = 0;
  const allRows = [];

  for (const page of pages) {
    const { rows } = convertPage(page.body);
    totalTexts += parseTextPlacements(page.body).length;
    allRows.push(...rows);
  }

  return { rows: allRows, pageCount: pages.length, texts: totalTexts };
}

function convertFile(inputPath, outDir) {
  const raw = fs.readFileSync(inputPath);
  const ps = extractPostScript(raw);
  const { rows, pageCount, texts } = convertPostScript(ps);

  const base = path.basename(inputPath, path.extname(inputPath));
  const dir = outDir || path.join(path.dirname(inputPath), "converted");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const csvPath = path.join(dir, `${base}.csv`);
  const txtPath = path.join(dir, `${base}.txt`);
  const jsonPath = path.join(dir, `${base}.json`);

  fs.writeFileSync(csvPath, toCsv(rows), "utf8");
  fs.writeFileSync(txtPath, toText(rows), "utf8");
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      { source: inputPath, texts, pageCount, rowCount: rows.length, rows },
      null,
      2
    ),
    "utf8"
  );

  return {
    csvPath,
    txtPath,
    jsonPath,
    cells: texts,
    rowCount: rows.length,
    pageCount,
  };
}

function collectInputs(arg) {
  const p = path.resolve(arg);
  if (!fs.existsSync(p)) throw new Error(`Not found: ${p}`);
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    return fs
      .readdirSync(p)
      .filter((f) => /\.ps$/i.test(f))
      .map((f) => path.join(p, f));
  }
  return [p];
}

module.exports = {
  convertFile,
  convertPostScript,
  extractPostScript,
  parseTextPlacements,
  parseRectangles,
  buildGridFromRectangles,
};

function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const outDir = outIdx >= 0 ? args[outIdx + 1] : null;
  const files = args.filter((a) => a !== "--out" && a !== outDir);

  if (!files.length) {
    console.error("Usage: node convert-ps.js <file.ps | folder> [--out dir]");
    process.exit(1);
  }

  for (const arg of files) {
    for (const file of collectInputs(arg)) {
      try {
        const r = convertFile(file, outDir);
        console.log(`${path.basename(file)}`);
        console.log(
          `  ${r.cells} text placements, ${r.pageCount} page(s) → ${r.rowCount} CSV rows`
        );
        console.log(`  CSV  → ${r.csvPath}`);
      } catch (err) {
        console.error(`  FAIL ${file}: ${err.message}`);
      }
    }
  }
}

if (require.main === module) main();
