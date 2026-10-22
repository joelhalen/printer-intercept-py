/**
 * php-notify.js — Fire-and-forget HTTP notifications from the print-server
 * proxy to the MegaFood pressing PHP app on the same host.
 *
 * Used when a new UNCOATED full ST-50 test is captured so the web app can
 * generate a First Piece document and queue a Control Center print prompt.
 */

const http = require("http");

/** Local-only endpoint; PHP rejects non-loopback callers. */
const NOTIFY_PATH = "/api/first-piece/uncoated-test";

/**
 * POST UNCOATED test metadata to the PHP app. Never throws; failures are ignored
 * so printing is never blocked by PHP availability.
 *
 * @param {object} payload
 * @param {string} payload.csvPath
 * @param {object} [payload.meta]
 * @param {object} [payload.summary]
 */
function notifyUncoatedTest(_cfg, payload) {
  const body = JSON.stringify({
    csv_path: payload.csvPath || null,
    meta: payload.meta || {},
    summary: payload.summary || {},
  });

  const req = http.request(
    {
      hostname: "127.0.0.1",
      port: 80,
      path: NOTIFY_PATH,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "User-Agent": "print-server-proxy",
      },
      timeout: 120000,
    },
    (res) => {
      res.resume();
    }
  );

  req.on("timeout", () => {
    req.destroy();
  });
  req.on("error", () => {
    // Best-effort only.
  });
  req.write(body);
  req.end();
}

module.exports = { notifyUncoatedTest };
