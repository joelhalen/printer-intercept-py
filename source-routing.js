/**
 * Map incoming client IPs to named sources, printer targets, and capture roots.
 */

const path = require("path");
const { sanitizePathSegment } = require("./job-meta");

const PLACEHOLDER_PRINTER = "192.168.1.X";

function normalizeClientIp(remoteAddress) {
  if (!remoteAddress) return "";
  const addr = String(remoteAddress).trim();
  if (addr.startsWith("::ffff:")) return addr.slice(7);
  if (addr === "::1") return "127.0.0.1";
  return addr;
}

function isPrinterConfigured(host) {
  return Boolean(host && host !== PLACEHOLDER_PRINTER);
}

/** @param {string|string[]} from */
function ipsFromEntry(from) {
  if (!from) return [];
  const list = Array.isArray(from) ? from : [from];
  return list.map(normalizeClientIp).filter(Boolean);
}

/**
 * @returns {Map<string, { name: string, printerHost: string, printerPort: number }>}
 */
function buildSourceIndex(cfg) {
  const index = new Map();
  const sources = Array.isArray(cfg.sources) ? cfg.sources : [];

  for (const entry of sources) {
    const name = sanitizePathSegment(entry.name);
    if (!name) continue;

    const printerHost = entry.printerHost || cfg.printerHost;
    const printerPort = entry.printerPort ?? cfg.printerPort ?? 9100;

    for (const ip of ipsFromEntry(entry.from ?? entry.ip ?? entry.address)) {
      index.set(ip, { name, printerHost, printerPort });
    }
  }
  return index;
}

/**
 * Per-connection settings: printer target + outputDir under captured_jobs/<name>/...
 * @param {object} baseCfg
 * @param {string} remoteAddress socket.remoteAddress
 */
function resolveConnectionContext(baseCfg, remoteAddress) {
  const clientIp = normalizeClientIp(remoteAddress);
  const index = buildSourceIndex(baseCfg);
  const rootOut = path.resolve(baseCfg.outputDir);
  const hasSources = index.size > 0;

  let sourceName = null;
  let printerHost = baseCfg.printerHost;
  let printerPort = baseCfg.printerPort ?? 9100;
  let mapped = false;
  let outputDir = rootOut;

  if (hasSources) {
    const match = index.get(clientIp);
    if (match) {
      sourceName = match.name;
      printerHost = match.printerHost;
      printerPort = match.printerPort;
      mapped = true;
      outputDir = path.join(rootOut, sourceName);
    } else {
      const unmappedRoot =
        sanitizePathSegment(baseCfg.unmappedSourceFolder) || "_unmapped";
      sourceName = sanitizePathSegment(clientIp) || "unknown-ip";
      mapped = false;
      outputDir = path.join(rootOut, unmappedRoot, sourceName);
    }
  }

  const config = {
    ...baseCfg,
    printerHost,
    printerPort,
    outputDir,
    _clientIp: clientIp,
    _sourceName: sourceName,
    _sourceMapped: mapped,
    _hasSourceRouting: hasSources,
  };

  return {
    clientIp,
    sourceName,
    printerHost,
    printerPort,
    mapped,
    hasSources,
    config,
  };
}

function formatRouteLabel(ctx) {
  if (!ctx.hasSources) return null;
  const tag = ctx.mapped ? ctx.sourceName : `${ctx.sourceName} (unmapped)`;
  return tag;
}

function listSourceRoutes(cfg) {
  const index = buildSourceIndex(cfg);
  const routes = [];
  for (const [ip, { name, printerHost, printerPort }] of index) {
    routes.push({ ip, name, printerHost, printerPort });
  }
  routes.sort((a, b) => a.name.localeCompare(b.name) || a.ip.localeCompare(b.ip));
  return routes;
}

module.exports = {
  normalizeClientIp,
  isPrinterConfigured,
  buildSourceIndex,
  resolveConnectionContext,
  formatRouteLabel,
  listSourceRoutes,
  PLACEHOLDER_PRINTER,
};
