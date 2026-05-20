/**
 * Parse ST-50 job metadata (PJL JOB NAME) and build storage paths.
 *
 * Example PJL:
 *   @PJL JOB NAME="1A;'1392B-10';'002';20260520;062136;ST50;00215"
 *     [0] report  [1] product  [2] lot/batch  [3] date  [4] time  [5] device  [6] press/serial
 */

const fs = require("fs");
const path = require("path");
const { parseTextPlacements, extractPostScript } = require("./convert-ps");

const DEFAULT_META = {
  reportType: "unknown",
  productId: "unknown-product",
  lot: "unknown-lot",
  press: "unknown-press",
  device: "unknown-device",
  jobDate: "",
  jobTime: "",
  testType: "unknown-test",
  side: "",
};

const ROW_Y_TOL = 8;

function sanitizePathSegment(value) {
  const s = String(value ?? "")
    .trim()
    .replace(/['"]/g, "")
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^-+|-+$/g, "");
  return s || "unknown";
}

function stripQuotes(s) {
  return String(s).replace(/^'+|'+$/g, "").trim();
}

function normalizeTestType(text) {
  const t = String(text).toUpperCase();
  if (/IN\s*PR\s*HARD/.test(t)) return "IN_PR_HARDNESS";
  if (/UNCOATED/.test(t)) return "UNCOATED";
  return sanitizePathSegment(text) || "unknown-test";
}

function normalizeSide(text) {
  const t = String(text).trim().toUpperCase();
  if (t === "L") return "L";
  if (t === "LEFT") return "LEFT";
  if (t === "LSFP") return "LSFP";
  if (t === "R") return "R";
  if (t === "RIGHT") return "RIGHT";
  if (t === "RSFP") return "RSFP";
  return "";
}

function valueBesideLabel(placements, label) {
  const labelP = placements.find(
    (p) => p.text.trim().toLowerCase() === label.toLowerCase()
  );
  if (!labelP) return "";

  let best = null;
  let bestDx = Infinity;
  for (const p of placements) {
    if (p === labelP || !p.text.trim()) continue;
    if (Math.abs(p.y - labelP.y) > ROW_Y_TOL) continue;
    if (p.x <= labelP.x + 15) continue;
    const dx = p.x - labelP.x;
    if (dx < bestDx) {
      bestDx = dx;
      best = p;
    }
  }
  return best ? best.text.trim() : "";
}

/** Read Sample Size + Comment from PostScript body text. */
function extractReportFields(data) {
  const text = Buffer.isBuffer(data)
    ? data.toString("latin1")
    : String(data);
  const ps = extractPostScript(text);
  const placements = parseTextPlacements(ps);

  let testType = "";
  let side = "";

  const sampleVal = valueBesideLabel(placements, "Sample Size");
  if (sampleVal) testType = normalizeTestType(sampleVal);

  const commentVal = valueBesideLabel(placements, "Comment");
  if (commentVal) side = normalizeSide(commentVal);

  if (!testType) {
    for (const p of placements) {
      if (/IN\s*PR\s*HARD/i.test(p.text)) {
        testType = "IN_PR_HARDNESS";
        break;
      }
      if (/UNCOATED/i.test(p.text)) {
        testType = "UNCOATED";
        break;
      }
    }
  }

  return {
    testType: testType || "unknown-test",
    side: side ? sanitizePathSegment(side) : "",
  };
}

/** @param {Buffer|string} data */
function extractJobMeta(data) {
  const head = Buffer.isBuffer(data)
    ? data.toString("latin1", 0, Math.min(data.length, 16384))
    : String(data).slice(0, 16384);

  const meta = { ...DEFAULT_META };

  const m = head.match(/@PJL\s+JOB\s+NAME="([^"]+)"/i);
  if (m) {
    const parts = m[1].split(";").map(stripQuotes);
    if (parts[0]) meta.reportType = sanitizePathSegment(parts[0]);
    if (parts[1]) meta.productId = sanitizePathSegment(parts[1]);
    if (parts[2]) meta.lot = sanitizePathSegment(parts[2]);
    if (parts[3]) meta.jobDate = sanitizePathSegment(parts[3]);
    if (parts[4]) meta.jobTime = sanitizePathSegment(parts[4]);
    if (parts[5]) meta.device = sanitizePathSegment(parts[5]);
    if (parts[6]) meta.press = sanitizePathSegment(parts[6]);
  }

  Object.assign(meta, extractReportFields(data));
  return meta;
}

function applyStorageTemplate(template, meta) {
  let tpl = template;
  if (!meta.side) {
    tpl = tpl.replace(/\/?\{side\}/g, "");
  }
  if (!meta.testType || meta.testType === "unknown-test") {
    tpl = tpl.replace(/\/?\{testType\}/g, "");
  }
  tpl = tpl.replace(/\/?\{press\}/g, "").replace(/\/?\{pressNumber\}/g, "");

  const vars = {
    productId: meta.productId,
    product: meta.productId,
    lot: meta.lot,
    batch: meta.lot,
    press: meta.press,
    pressNumber: meta.press,
    serial: meta.press,
    device: meta.device,
    reportType: meta.reportType,
    jobDate: meta.jobDate,
    jobTime: meta.jobTime,
    testType: meta.testType,
    side: meta.side,
  };

  let rel = tpl;
  for (const [key, value] of Object.entries(vars)) {
    rel = rel.replace(new RegExp(`\\{${key}\\}`, "g"), value || "");
  }
  return rel
    .split(/[/\\]+/)
    .filter((s) => s && s !== "undefined");
}

function buildJobStorageDir(cfg, meta) {
  const root = path.resolve(cfg.outputDir);
  if (!cfg.organizeByJobMeta) return root;

  const template =
    cfg.storagePathTemplate || "{productId}/lot_{lot}/{side}";
  const segments = applyStorageTemplate(template, meta);
  return path.join(root, ...segments);
}

function captureTimestamp() {
  const now = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "_",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

function makeJobBasename(meta, cfg) {
  const stamp = captureTimestamp();
  const parts = ["job"];

  if (cfg.organizeByJobMeta && meta.jobDate && meta.jobTime) {
    parts.push(meta.jobDate, meta.jobTime);
  } else {
    parts.push(stamp);
  }

  if (meta.testType && meta.testType !== "unknown-test") {
    parts.push(meta.testType);
  }
  if (meta.side) {
    parts.push(meta.side);
  }

  return parts.join("_");
}

function ensureUniquePath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  for (let n = 2; n < 1000; n++) {
    const candidate = path.join(dir, `${base}_${n}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${base}_${Date.now()}${ext}`);
}

/**
 * Plan .ps path (and metadata) from captured job bytes.
 * @returns {{ meta, jobFile, storageDir, convertDir }}
 */
function resolveJobPaths(data, cfg) {
  const meta = extractJobMeta(data);
  const storageDir = buildJobStorageDir(cfg, meta);
  const basename = makeJobBasename(meta, cfg);
  const jobFile = ensureUniquePath(path.join(storageDir, `${basename}.ps`));

  const convertSub = cfg.autoConvertDir ?? "converted";
  const convertDir = path.isAbsolute(convertSub)
    ? convertSub
    : path.join(storageDir, convertSub);

  return { meta, jobFile, storageDir, convertDir };
}

function formatMetaLog(meta) {
  const bits = [
    `product=${meta.productId}`,
    `lot=${meta.lot}`,
    `press=${meta.press}`,
    `test=${meta.testType}`,
  ];
  if (meta.side) bits.push(`side=${meta.side}`);
  return bits.join(" ");
}

module.exports = {
  extractJobMeta,
  buildJobStorageDir,
  resolveJobPaths,
  formatMetaLog,
  sanitizePathSegment,
};
