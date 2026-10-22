/**
 * printer-keepalive.js — Keep each target printer awake, remember its latest
 * PJL status reply, and help deliver jobs to a printer that is waking up.
 *
 * Why: the ST-50 sends a short PJL status probe before every print and only
 * waits briefly for the answer. When the Xerox is in power-saver mode it can
 * take several seconds to reply, so the ST-50 gives up with "printer not
 * found" even though the printer would have printed fine a moment later.
 *
 * This module does three things:
 *   1. Keep-alive: on a timer (24/7 by default, or only within activeHours) it
 *      sends the ST-50's own status probe to every configured printer. This
 *      keeps the printer's network side responsive and keeps a fresh copy of
 *      its genuine status reply.
 *   2. Reply cache: the latest printer reply per probe kind (INFO STATUS, …)
 *      lets the proxy answer the ST-50 instantly with the printer's real words.
 *   3. Wake-then-forward: before forwarding a job to a printer that has not
 *      answered recently, send a wake probe first, and retry the forward when
 *      the printer refuses or does not accept the connection.
 *
 * All traffic to one printer is serialized (withPrinter) so keep-alive probes
 * never overlap a probe relay or a job on the same printer.
 */

const DEFAULT_KEEP_ALIVE = {
  enabled: true,
  intervalSeconds: 60,     // how often to poll each printer
  activeHours: "",         // "" = 24/7, or e.g. "05:00-23:00" (may wrap midnight)
  statusCacheSeconds: 180, // how long a cached printer reply may answer the ST-50
  probeDeadlineMs: 1500,   // with no cached reply, answer the ST-50 after this long
                           // with the canned "Ready" status instead of waiting
  wakeTimeoutMs: 15000,    // max wait for a sleeping printer before forwarding
  forwardRetryDelaysSeconds: [5, 15, 30], // retries when the printer refuses a job
};

// The exact status probe the ST-50 sends (see sniff.js / sniff_logs).
const ST50_STATUS_PROBE = Buffer.from(
  "\x1B%-12345X@PJL INFO STATUS\r\n\x1B%-12345X@PJL\r\n",
  "latin1"
);

/** keepAlive settings from config.json merged over the defaults. */
function resolveSettings(cfg) {
  return { ...DEFAULT_KEEP_ALIVE, ...((cfg && cfg.keepAlive) || {}) };
}

function targetOf(cfg) {
  return { host: cfg.printerHost, port: cfg.printerPort ?? 9100 };
}

function keyOf(target) {
  return `${target.host}:${target.port}`;
}

// ─── Per-printer state ───────────────────────────────────────────────────────

const states = new Map();

function stateFor(target) {
  const key = keyOf(target);
  if (!states.has(key)) {
    states.set(key, {
      key,
      chain: Promise.resolve(),
      replies: new Map(), // probe kind → { reply: Buffer, at: ms }
      lastReplyAt: 0,
      reachable: null,    // null = unknown, true / false after first contact
      sessions: 0,        // open transparent-mode sessions
    });
  }
  return states.get(key);
}

/** Run fn() with exclusive use of this printer (one connection at a time). */
function withPrinter(target, fn) {
  const st = stateFor(target);
  const next = st.chain.then(fn, fn);
  st.chain = next.catch(() => {});
  return next;
}

/** Mark a transparent-mode session open; returns a function to close it. */
function trackSession(target) {
  const st = stateFor(target);
  st.sessions += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    st.sessions -= 1;
    st.lastReplyAt = Date.now();
  };
}

/** Cache key for a probe: the set of PJL INFO commands it asks for. */
function probeKind(payload) {
  const text = payload.toString("latin1");
  const kinds = [];
  for (const m of text.matchAll(/@PJL\s+INFO\s+(\w+)/gi)) {
    const k = m[1].toUpperCase();
    if (!kinds.includes(k)) kinds.push(k);
  }
  return kinds.sort().join("+");
}

function recordReply(target, payload, reply) {
  if (!reply || reply.length === 0) return;
  const st = stateFor(target);
  const now = Date.now();
  st.replies.set(probeKind(payload), { reply, at: now });
  st.lastReplyAt = now;
}

/** Printer's cached reply to this kind of probe, if fresh enough. */
function getCachedReply(target, payload, maxAgeMs) {
  const st = states.get(keyOf(target));
  if (!st) return null;
  const hit = st.replies.get(probeKind(payload));
  if (!hit) return null;
  const age = Date.now() - hit.at;
  return age <= maxAgeMs ? { reply: hit.reply, ageMs: age } : null;
}

function noteReachable(target, ok, detail, log) {
  const st = stateFor(target);
  if (st.reachable === ok) return;
  st.reachable = ok;
  if (!log) return;
  if (ok) log("normal", `Printer ${st.key} is responding${detail ? ` (${detail})` : ""}`);
  else log("normal", `Printer ${st.key} is NOT responding (${detail}) — will keep trying`);
}

// ─── Active hours ────────────────────────────────────────────────────────────

function parseHm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) return null;
  return h * 60 + min;
}

/**
 * True when `date` falls inside an "HH:MM-HH:MM" window (local time). An empty
 * or unparseable spec means always active. Windows may wrap past midnight.
 */
function isWithinActiveHours(spec, date = new Date()) {
  if (!spec) return true;
  const [a, b] = String(spec).split("-");
  const start = parseHm(a);
  const end = parseHm(b);
  if (start === null || end === null || start === end) return true;
  const now = date.getHours() * 60 + date.getMinutes();
  return start < end ? now >= start && now < end : now >= start || now < end;
}

// ─── Wake + forward ──────────────────────────────────────────────────────────

/**
 * Send a status probe to a printer that has not answered recently, so it is
 * awake before a job arrives. Never throws.
 *
 * @param {object} cfg       resolved per-connection config
 * @param {function} probeFn (payload, cfg, timeoutMs) => Promise<Buffer>
 */
async function ensureAwake(cfg, probeFn, log) {
  const settings = resolveSettings(cfg);
  const target = targetOf(cfg);
  const st = stateFor(target);
  if (Date.now() - st.lastReplyAt < settings.intervalSeconds * 1000 * 1.5) return true;

  log && log("normal", `  Waking printer ${st.key} before forwarding…`);
  const started = Date.now();
  try {
    const reply = await withPrinter(target, () =>
      probeFn(ST50_STATUS_PROBE, cfg, settings.wakeTimeoutMs)
    );
    recordReply(target, ST50_STATUS_PROBE, reply);
    noteReachable(target, true, null, log);
    log && log("normal", `  Printer awake (answered in ${Date.now() - started} ms)`);
    return true;
  } catch (err) {
    log && log("normal", `  Wake probe got no answer (${err.message}) — forwarding anyway`);
    return false;
  }
}

/**
 * Forward a job, waking the printer first and retrying while the printer
 * refuses or does not accept the connection. A failure after the printer
 * accepted the connection is not retried, so a job is never printed twice.
 *
 * @param {function} forwardFn (data, cfg) => Promise; rejects with
 *                             err.connected = true once data may have reached the printer
 */
async function forwardWithWake(data, cfg, { forwardFn, probeFn, log, sleep = defaultSleep }) {
  const settings = resolveSettings(cfg);
  const target = targetOf(cfg);
  if (settings.enabled) await ensureAwake(cfg, probeFn, log);

  const delays = settings.enabled ? settings.forwardRetryDelaysSeconds || [] : [];
  for (let attempt = 0; ; attempt++) {
    try {
      await withPrinter(target, () => forwardFn(data, cfg));
      stateFor(target).lastReplyAt = Date.now();
      noteReachable(target, true, null, log);
      return;
    } catch (err) {
      if (err.connected || attempt >= delays.length) throw err;
      const wait = delays[attempt];
      log && log("normal", `  Printer did not accept the job (${err.message}) — retry ${attempt + 1}/${delays.length} in ${wait}s`);
      await sleep(wait * 1000);
    }
  }
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Keep-alive loop ─────────────────────────────────────────────────────────

/**
 * Poll one printer if it is due. Skips when a session is open or the printer
 * answered something recently (it is already awake and the cache is fresh).
 */
async function pollTarget(cfg, probeFn, log, now = new Date()) {
  const settings = resolveSettings(cfg);
  const target = targetOf(cfg);
  const st = stateFor(target);
  if (!isWithinActiveHours(settings.activeHours, now)) return "outside-hours";
  if (st.sessions > 0) return "busy";
  if (Date.now() - st.lastReplyAt < settings.intervalSeconds * 1000 * 0.9) return "fresh";

  try {
    const reply = await withPrinter(target, () =>
      probeFn(ST50_STATUS_PROBE, cfg, settings.wakeTimeoutMs)
    );
    recordReply(target, ST50_STATUS_PROBE, reply);
    noteReachable(target, true, describeStatus(reply), log);
    return "ok";
  } catch (err) {
    noteReachable(target, false, err.message, log);
    return "failed";
  }
}

function describeStatus(reply) {
  const m = /DISPLAY="([^"]*)"/i.exec(reply.toString("latin1"));
  return m ? `status "${m[1]}"` : null;
}

/**
 * Start polling every distinct printer in `targetCfgs` (one resolved config
 * per printer). Returns a stop() function.
 */
function start(baseCfg, targetCfgs, probeFn, log) {
  const settings = resolveSettings(baseCfg);
  if (!settings.enabled) return () => {};

  const seen = new Set();
  const cfgs = targetCfgs.filter((c) => {
    const k = keyOf(targetOf(c));
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const tick = () => {
    for (const c of cfgs) pollTarget(c, probeFn, log).catch(() => {});
  };
  tick();
  const timer = setInterval(tick, Math.max(10, settings.intervalSeconds) * 1000);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

/** Test helper: forget all printer state. */
function _reset() {
  states.clear();
}

module.exports = {
  DEFAULT_KEEP_ALIVE,
  ST50_STATUS_PROBE,
  resolveSettings,
  targetOf,
  withPrinter,
  trackSession,
  probeKind,
  recordReply,
  getCachedReply,
  isWithinActiveHours,
  ensureAwake,
  forwardWithWake,
  pollTarget,
  start,
  _reset,
};
