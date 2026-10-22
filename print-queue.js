/**
 * print-queue.js — Filesystem queue of "held" print jobs awaiting a human
 * decision on the Control Center PC.
 *
 * When the proxy decides not to auto-print a job (a hardness-only test, or an
 * invalid test), it writes one JSON descriptor here. The PHP web app reads this
 * directory (it already has the print-server path via PRINT_SERVER_PATH),
 * shows a pop-up on the Control Center PC, and then either prints the original
 * captured .ps or dismisses the entry — in both cases the JSON file is removed.
 *
 * No database is involved; the two applications already share this filesystem.
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_QUEUE_DIRNAME = "print_queue";
const ID_RE = /^[A-Za-z0-9_-]+$/;

/** Absolute path to the queue directory for a given config. */
function resolveQueueDir(cfg) {
  const dir = cfg && cfg.printQueueDir ? cfg.printQueueDir : DEFAULT_QUEUE_DIRNAME;
  return path.isAbsolute(dir) ? dir : path.join(__dirname, dir);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeId() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` +
    `_${p(d.getMilliseconds(), 3)}`;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${stamp}_${rand}`;
}

/**
 * Add a held job to the queue.
 *
 * @param {object} cfg                 Parsed config.json (for printQueueDir)
 * @param {object} input
 * @param {number} [input.deviceTarget=8]   Device id that should be prompted
 * @param {'hardness'|'invalid'} input.reason
 * @param {string[]} [input.errors]
 * @param {'full'|'hardness'} [input.testType]
 * @param {object} [input.meta]        product / lot / side / press / device
 * @param {string} input.psPath        absolute path to captured .ps
 * @param {string} [input.csvPath]
 * @param {object} [input.summary]     classifier summary block
 * @returns {{ id: string, file: string, entry: object }}
 */
function enqueue(cfg, input) {
  const dir = ensureDir(resolveQueueDir(cfg));
  const id = makeId();
  const now = new Date();
  const entry = {
    id,
    status: "pending",
    created_at: now.toISOString(),
    created_ts: now.getTime(),
    device_target: input.deviceTarget != null ? input.deviceTarget : 8,
    reason: input.reason, // "hardness" | "invalid"
    errors: Array.isArray(input.errors) ? input.errors : [],
    test_type: input.testType || null,
    meta: input.meta || {},
    ps_path: input.psPath || null,
    csv_path: input.csvPath || null,
    summary: input.summary || null,
  };
  const file = path.join(dir, `${id}.json`);
  // Write atomically: temp file then rename so the PHP poller never reads a
  // half-written descriptor.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entry, null, 2), "utf8");
  fs.renameSync(tmp, file);
  return { id, file, entry };
}

/** List pending entries (oldest first). Skips unreadable / malformed files. */
function list(cfg) {
  const dir = resolveQueueDir(cfg);
  if (!fs.existsSync(dir)) return [];
  const entries = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, name), "utf8");
      const obj = JSON.parse(raw);
      entries.push(obj);
    } catch (_) {
      // ignore malformed/partial files
    }
  }
  entries.sort((a, b) => (a.created_ts || 0) - (b.created_ts || 0));
  return entries;
}

function get(cfg, id) {
  if (!ID_RE.test(String(id || ""))) return null;
  const file = path.join(resolveQueueDir(cfg), `${id}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return null;
  }
}

/** Remove an entry (after it has been printed or dismissed). */
function remove(cfg, id) {
  if (!ID_RE.test(String(id || ""))) return false;
  const file = path.join(resolveQueueDir(cfg), `${id}.json`);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

module.exports = {
  DEFAULT_QUEUE_DIRNAME,
  resolveQueueDir,
  enqueue,
  list,
  get,
  remove,
};
