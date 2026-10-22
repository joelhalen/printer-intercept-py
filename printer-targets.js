/**
 * Printer targets from config.json — shared by resend.js and documented for the PHP Job Browser.
 */

const net = require("net");
const { isPrinterConfigured, PLACEHOLDER_PRINTER } = require("./source-routing");

/**
 * @typedef {{ id: string, label: string, host: string, port: number, source_name: string|null }} PrinterTarget
 */

/**
 * @param {object} cfg  Parsed config.json
 * @returns {PrinterTarget[]}
 */
function listPrinterTargets(cfg) {
  const targets = [];
  const defaultHost = cfg.printerHost;
  const defaultPort = cfg.printerPort ?? 9100;

  if (isPrinterConfigured(defaultHost)) {
    targets.push({
      id: "default",
      label: `Default printer (${defaultHost}:${defaultPort})`,
      host: defaultHost,
      port: defaultPort,
      source_name: null,
    });
  }

  const sources = Array.isArray(cfg.sources) ? cfg.sources : [];
  for (const entry of sources) {
    const name = entry.name ? String(entry.name).trim() : "";
    if (!name) continue;
    const host = entry.printerHost || defaultHost;
    const port = entry.printerPort ?? defaultPort;
    if (!isPrinterConfigured(host)) continue;
    targets.push({
      id: `source:${name}`,
      label: `${name} (${host}:${port})`,
      host,
      port,
      source_name: name,
    });
  }

  return targets;
}

/**
 * @param {object} cfg
 * @param {string} [targetId]  "default" or "source:<name>"
 * @returns {PrinterTarget|null}
 */
function resolvePrinterTarget(cfg, targetId) {
  const targets = listPrinterTargets(cfg);
  if (!targetId || targetId === "default") {
    return targets.find((t) => t.id === "default") ?? targets[0] ?? null;
  }
  return targets.find((t) => t.id === targetId) ?? null;
}

/**
 * Send raw job bytes to a printer (same TCP write as proxy forwardToPrinter).
 *
 * @param {Buffer} data
 * @param {string} host
 * @param {number} port
 * @returns {Promise<{ bytes: number }>}
 */
function sendToPrinter(data, host, port) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    let sent = 0;

    client.connect(port, host, () => {
      client.write(data, (err) => {
        if (err) return reject(err);
        sent = data.length;
        client.end();
      });
    });

    client.on("close", () => resolve({ bytes: sent }));
    client.on("error", reject);
    client.setTimeout(15000, () => {
      client.destroy();
      reject(new Error("Connection timed out"));
    });
  });
}

module.exports = {
  listPrinterTargets,
  resolvePrinterTarget,
  sendToPrinter,
  PLACEHOLDER_PRINTER,
};
