/**
 * classify-test.js — Decide what to do with an intercepted ST-50 print job.
 *
 * The ST-50 prints two kinds of reports:
 *   • a "full" test  — hardness + thickness (+ weight) measurements, and
 *   • a "hardness-only" test — hardness measurements only.
 *
 * Business rules (see integration spec):
 *   1. A hardness-only test must NEVER auto-print. It is held and offered to
 *      the Control Center PC as a print/dismiss decision.
 *   2. Any test whose values are invalid (all null, all zero, or a relative
 *      standard deviation above the threshold on hardness / thickness / weight)
 *      must NEVER auto-print — even a full / first-piece document — and is held
 *      with an explanation of what looked wrong.
 *   3. Everything else (a valid full test) prints automatically, exactly as the
 *      proxy behaves today.
 *
 * Scope guard (rules 1 & 2 only apply to OUR test types):
 *   The ST-50 is shared with other departments whose reports do not fall under
 *   our pressing specifications (e.g. capsule weight-only tests). Those reports
 *   carry a different "Sample Size" test type and must NEVER be held — holding
 *   them would block another department's printout. Only reports whose Sample
 *   Size matches one of the test types we actually handle (UNCOATED, EasyTest,
 *   or an in-process HARDNESS test) are subject to the hold rules; anything else
 *   auto-prints unconditionally.
 *
 * This module re-implements the same CSV interpretation as the PHP
 * App\Services\St50CsvParserService so the proxy and the web app agree on what
 * a job contains. It operates on the row grid produced by convert-ps.js, so it
 * never needs the printer or the web app to make a decision.
 */

const { convertPostScript, extractPostScript } = require("./convert-ps");

// A relative standard deviation (Srel.) above this fraction is treated as
// "highly abnormal" and forces a Control Center confirmation before printing.
const DEFAULT_RSD_LIMIT = 0.10; // 10%

// The "Sample Size" test types we own. A report whose Sample Size matches one of
// these patterns (case-insensitive) is subject to the hold rules; any other
// (non-empty) Sample Size belongs to another department and always auto-prints.
// Each entry is a case-insensitive regular-expression source string and can be
// overridden via the `recognizedTestTypes` option / config key.
const DEFAULT_RECOGNIZED_TEST_TYPES = [
  "UNCOATED",
  "EASY\\s*TEST",     // "EasyTest" / "Easy Test"
  "HARDNESS",          // bare "HARDNESS"
  "IN\\s*PR\\s*HARD",  // "IN PR HARDNESS" (in-process hardness)
];

/**
 * Match a report's Sample Size against the recognized test-type patterns.
 *
 * @param {string} sampleType  The raw "Sample Size" value from the report header.
 * @param {string[]} [patterns]  Override list of regex source strings.
 * @returns {string|null}  The matching pattern source when recognized, else null.
 *                         Note: an empty / missing sample type also returns null;
 *                         callers treat "unknown" conservatively (see classifyParsed).
 */
function matchRecognizedTestType(sampleType, patterns = DEFAULT_RECOGNIZED_TEST_TYPES) {
  const s = String(sampleType == null ? "" : sampleType).trim();
  if (s === "") return null;
  for (const src of patterns) {
    try {
      if (new RegExp(src, "i").test(s)) return src;
    } catch (_e) {
      // Bad pattern in config — skip it rather than crash classification.
    }
  }
  return null;
}

// Page-2 statistics columns, matching St50CsvParserService::parseStatistics.
const STAT_PARAM_COLS = { 1: "hardness", 5: "thickness", 6: "weight" };
const STAT_ROW_LABELS = {
  "#Values": "count",
  Mean: "mean",
  Xmax: "max",
  Xmin: "min",
  "Srel.": "rsd_pct",
  "T1 Viol.": "t1_violations",
  "T2 Viol.": "t2_violations",
};

function cell(row, col) {
  return String((row && row[col] != null ? row[col] : "")).trim();
}

/** Split the flat row grid into page-1 / page-2 at the 2nd "Company Name,MegaFood". */
function splitPages(rows) {
  let found = 0;
  for (let i = 0; i < rows.length; i++) {
    if (cell(rows[i], 0) === "Company Name" && cell(rows[i], 1) === "MegaFood") {
      found++;
      if (found === 2) {
        return { page1: rows.slice(0, i), page2: rows.slice(i), ok: true };
      }
    }
  }
  // Fall back to a single page when the 2nd header marker is missing so we can
  // still classify (and flag) partial / malformed reports instead of throwing.
  return { page1: rows, page2: [], ok: found > 0 };
}

function parseHeader(rows) {
  const header = {};
  for (const row of rows) {
    switch (cell(row, 0)) {
      case "Company Name":
        header.company = cell(row, 1);
        break;
      case "Serial Number":
        header.device_model = cell(row, 1);
        header.serial_number = cell(row, 2);
        break;
      case "Product":
        header.product_code = cell(row, 1);
        header.product_description = cell(row, 5);
        break;
      case "Sample Size":
        header.sample_type = cell(row, 1);
        break;
      case "Batch":
        header.batch_number = cell(row, 1);
        header.operator = cell(row, 5);
        break;
      case "Comment":
        header.press_side = cell(row, 1);
        break;
      default:
        break;
    }
  }
  return header;
}

/** Per-tablet rows after the "Parameter" header. Empty cells → null. */
function parseMeasurements(rows) {
  const out = [];
  let inData = false;
  for (const row of rows) {
    const c0 = cell(row, 0);
    if (c0 === "Parameter") {
      inData = true;
      continue;
    }
    if (!inData) continue;
    if (c0 === "" || !isNumeric(c0)) continue;
    const nv = (col) => {
      const v = cell(row, col);
      return v !== "" ? v : null;
    };
    out.push({
      row: parseInt(c0, 10),
      hardness: nv(1),
      diameter: nv(3),
      width: nv(4),
      thickness: nv(5),
      weight: nv(6),
    });
  }
  return out;
}

/** Aggregate stats from page 2, keyed hardness/thickness/weight. */
function parseStatistics(rows) {
  const stats = { hardness: {}, thickness: {}, weight: {} };
  for (const row of rows) {
    const label = cell(row, 0);
    const key = STAT_ROW_LABELS[label];
    if (!key) continue;
    for (const [colStr, param] of Object.entries(STAT_PARAM_COLS)) {
      const col = Number(colStr);
      const raw = cell(row, col);
      if (raw === "") {
        if (key === "rsd_pct") {
          stats[param].rsd_pct = null;
          stats[param].rsd_decimal = null;
        } else {
          stats[param][key] = null;
        }
        continue;
      }
      if (key === "rsd_pct") {
        stats[param].rsd_pct = raw; // e.g. "5.9%"
        stats[param].rsd_decimal = parseFloat(raw.replace(/%\s*$/, "")) / 100;
      } else {
        stats[param][key] = raw;
      }
    }
  }
  return stats;
}

function isNumeric(value) {
  if (value == null) return false;
  const s = String(value).trim();
  if (s === "") return false;
  return !Number.isNaN(Number(s));
}

function toNumber(value) {
  if (value == null) return null;
  const s = String(value).trim().replace(/[^0-9.\-]/g, "");
  if (s === "" || s === "-" || s === ".") return null;
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

/**
 * Parse a converted ST-50 row grid into header / measurements / statistics.
 * @param {string[][]} rows  Grid from convert-ps.js
 */
function parseGrid(rows) {
  const { page1, page2, ok } = splitPages(rows);
  return {
    structured: ok,
    header: parseHeader(page1),
    measurements: parseMeasurements(page1),
    statistics: parseStatistics(page2.length ? page2 : page1),
  };
}

/**
 * Classify a parsed report.
 *
 * @param {{header:object, measurements:Array, statistics:object, structured?:boolean}} parsed
 * @param {{ rsdLimit?: number }} [opts]
 * @returns {{
 *   testType: 'full'|'hardness',
 *   valid: boolean,
 *   shouldAutoPrint: boolean,
 *   holdReason: 'hardness'|'invalid'|null,
 *   errors: string[],
 *   summary: object
 * }}
 */
function classifyParsed(parsed, opts = {}) {
  const rsdLimit = typeof opts.rsdLimit === "number" ? opts.rsdLimit : DEFAULT_RSD_LIMIT;
  const recognizedPatterns = Array.isArray(opts.recognizedTestTypes) && opts.recognizedTestTypes.length
    ? opts.recognizedTestTypes
    : DEFAULT_RECOGNIZED_TEST_TYPES;
  const stats = parsed.statistics || {};
  const measurements = parsed.measurements || [];

  // Which test type is this? Reports we don't own (a non-empty Sample Size that
  // doesn't match our patterns) belong to another department and always print.
  const sampleType = String((parsed.header && parsed.header.sample_type) || "").trim();
  const recognizedTestType = matchRecognizedTestType(sampleType, recognizedPatterns);
  // "Foreign" = a clearly-labeled report that isn't one of ours. An empty/unknown
  // Sample Size is NOT treated as foreign — we keep the conservative hold rules so
  // a genuine but poorly-labeled hardness test is still reviewed rather than printed.
  const isForeignTestType = sampleType !== "" && recognizedTestType === null;

  const thicknessMean = stats.thickness ? stats.thickness.mean : null;
  const hasThickness = thicknessMean != null && String(thicknessMean).trim() !== "";
  const testType = hasThickness ? "full" : "hardness";

  const errors = [];

  // The parameters that are meaningful for this report type.
  const params = testType === "full"
    ? ["hardness", "thickness", "weight"]
    : ["hardness"];

  // 1. Structure / presence: any usable measurements at all?
  const anyMeasurement = measurements.some(
    (m) => m.hardness != null || m.thickness != null || m.weight != null
  );
  if (!parsed.structured) {
    errors.push("Report structure was not recognized (missing or malformed ST-50 pages).");
  }
  if (!anyMeasurement) {
    errors.push("No measurement values were recorded (all rows are empty).");
  }

  // 2. All-zero / all-null means for the relevant parameters.
  for (const p of params) {
    const s = stats[p] || {};
    const mean = toNumber(s.mean);
    const count = toNumber(s.count);
    if (s.mean == null || String(s.mean).trim() === "") {
      errors.push(`${capitalize(p)} has no mean value.`);
    } else if (mean === 0) {
      errors.push(`${capitalize(p)} mean is 0.`);
    }
    if (count != null && count === 0) {
      errors.push(`${capitalize(p)} has 0 recorded values.`);
    }
  }

  // 3. Relative standard deviation (Srel.) above the abnormal threshold.
  for (const p of params) {
    const s = stats[p] || {};
    const rsd = s.rsd_decimal;
    if (rsd != null && !Number.isNaN(rsd) && rsd > rsdLimit) {
      errors.push(
        `${capitalize(p)} RSD ${(rsd * 100).toFixed(1)}% exceeds ${(rsdLimit * 100).toFixed(0)}%.`
      );
    }
  }

  const valid = errors.length === 0;

  // Hold the job when it is hardness-only OR when it is invalid (rule 1 & 2).
  let holdReason = null;
  if (!valid) holdReason = "invalid";
  else if (testType === "hardness") holdReason = "hardness";

  // Scope guard: the hold rules only apply to test types we own. A report from
  // another department (a non-spec Sample Size) always auto-prints, even if our
  // hardness/validity heuristics would otherwise have flagged it.
  if (isForeignTestType) holdReason = null;

  const shouldAutoPrint = holdReason === null;

  return {
    testType,
    valid,
    shouldAutoPrint,
    holdReason,
    errors,
    sampleType,
    recognizedTestType,
    foreign: isForeignTestType,
    summary: buildSummary(parsed, testType),
  };
}

function buildSummary(parsed, testType) {
  const h = parsed.header || {};
  const s = parsed.statistics || {};
  const pick = (param) => {
    const o = s[param] || {};
    return {
      mean: o.mean ?? null,
      min: o.min ?? null,
      max: o.max ?? null,
      rsd_pct: o.rsd_pct ?? null,
      count: o.count ?? null,
    };
  };
  return {
    test_type: testType,
    product_code: h.product_code ?? null,
    product_description: h.product_description ?? null,
    batch_number: h.batch_number ?? null,
    operator: h.operator ?? null,
    press_side: h.press_side ?? null,
    sample_type: h.sample_type ?? null,
    serial_number: h.serial_number ?? null,
    hardness: pick("hardness"),
    thickness: pick("thickness"),
    weight: pick("weight"),
  };
}

function capitalize(s) {
  return String(s).charAt(0).toUpperCase() + String(s).slice(1);
}

/**
 * Convenience: classify directly from raw captured job bytes / PostScript text.
 * @param {Buffer|string} data
 * @param {{ rsdLimit?: number }} [opts]
 */
function classifyJob(data, opts = {}) {
  let parsed;
  try {
    const ps = extractPostScript(data);
    const { rows } = convertPostScript(ps);
    parsed = parseGrid(rows);
  } catch (err) {
    // Not PostScript / unparseable: cannot validate → hold as invalid so a human
    // decides rather than silently auto-printing something we don't understand.
    return {
      testType: "hardness",
      valid: false,
      shouldAutoPrint: false,
      holdReason: "invalid",
      errors: [`Could not parse job as an ST-50 report: ${err.message}`],
      sampleType: "",
      recognizedTestType: null,
      foreign: false,
      summary: buildSummary({ header: {}, statistics: {} }, "hardness"),
    };
  }
  return classifyParsed(parsed, opts);
}

module.exports = {
  DEFAULT_RSD_LIMIT,
  DEFAULT_RECOGNIZED_TEST_TYPES,
  matchRecognizedTestType,
  parseGrid,
  classifyParsed,
  classifyJob,
};

// CLI: node classify-test.js <file.ps|file.csv>
if (require.main === module) {
  const fs = require("fs");
  const path = require("path");
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: node classify-test.js <captured-job.ps>");
    process.exit(1);
  }
  const raw = fs.readFileSync(path.resolve(file));
  const result = classifyJob(raw);
  console.log(JSON.stringify(result, null, 2));
}
