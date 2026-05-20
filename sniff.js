/**
 * Talk directly to the Xerox on port 9100 and save raw responses.
 * Use this to see exactly what the printer sends (then compare to proxy logs).
 *
 * Usage:
 *   node sniff.js 10.3.10.209
 *   node sniff.js 10.3.10.209 --job sample.ps
 */

const net = require("net");
const fs = require("fs");
const path = require("path");

const host = process.argv[2];
const port = parseInt(process.argv[3] === "--job" ? "9100" : process.argv[3] || "9100", 10);
const jobArgIdx = process.argv.indexOf("--job");
const jobFile = jobArgIdx >= 0 ? process.argv[jobArgIdx + 1] : null;

if (!host) {
  console.error("Usage: node sniff.js <printer-ip> [port]");
  console.error("       node sniff.js <printer-ip> --job <file.ps>");
  process.exit(1);
}

const CRLF = "\r\n";
const OUT_DIR = path.join(__dirname, "sniff_logs");

const ST50_STATUS = Buffer.from(
  "\x1B%-12345X@PJL INFO STATUS\r\n\x1B%-12345X@PJL\r\n",
  "latin1"
);

const PROBES = [
  { name: "info_id", send: Buffer.from(`@PJL INFO ID${CRLF}`, "latin1") },
  { name: "info_status", send: Buffer.from(`@PJL INFO STATUS${CRLF}`, "latin1") },
  { name: "info_config", send: Buffer.from(`@PJL INFO CONFIG${CRLF}`, "latin1") },
  { name: "st50_status_exact", send: ST50_STATUS },
];

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function saveBin(name, buf) {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const base = path.join(OUT_DIR, `${stamp()}_${host.replace(/\./g, "-")}_${name}`);
  fs.writeFileSync(`${base}.bin`, buf);
  const preview = buf.toString("latin1").replace(/[^\x20-\x7e\r\n]/g, ".");
  fs.writeFileSync(
    `${base}.txt`,
    `bytes: ${buf.length}\nhex: ${buf.slice(0, 256).toString("hex")}${buf.length > 256 ? "…" : ""}\n\n${preview}`
  );
  console.log(`  saved ${base}.bin (${buf.length} B)`);
}

function exchange(label, payload, waitMs = 3000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = new net.Socket();

    const done = (err) => {
      socket.destroy();
      if (err) reject(err);
      else resolve(Buffer.concat(chunks));
    };

    socket.setTimeout(10000, () => done(new Error("timeout")));
    socket.on("error", done);
    socket.on("data", (c) => chunks.push(c));

    socket.connect(port, host, () => {
      console.log(`\n[${label}] send ${payload.length} B`);
      socket.write(payload, () => {
        setTimeout(() => done(), waitMs);
      });
    });
  });
}

async function main() {
  console.log("═".repeat(60));
  console.log(`Sniff printer ${host}:${port}`);
  console.log(`Output: ${OUT_DIR}`);
  console.log("═".repeat(60));

  for (const probe of PROBES) {
    try {
      const reply = await exchange(probe.name, probe.send);
      saveBin(probe.name, reply);
      if (reply.length === 0) console.log("  (no response)");
      else {
        const text = reply.toString("latin1").trim();
        console.log(`  reply preview: ${text.slice(0, 120).replace(/\r?\n/g, " | ")}`);
      }
    } catch (err) {
      console.log(`  FAIL: ${err.message}`);
    }
  }

  const minimalPs = Buffer.from("%!PS-Adobe-3.0\r\n(Sniff test) show\r\n\x0c", "latin1");
  const jobPayload = jobFile && fs.existsSync(jobFile) ? fs.readFileSync(jobFile) : minimalPs;

  try {
    const reply = await exchange(jobFile ? "postscript_file" : "postscript_minimal", jobPayload, 5000);
    saveBin(jobFile ? "postscript_file" : "postscript_minimal", reply);
    saveBin("postscript_sent", jobPayload);
    console.log(`  sent ${jobPayload.length} B PostScript`);
    if (reply.length) console.log(`  printer returned ${reply.length} B after job`);
    else console.log("  (no bytes back after job — normal for many raw printers)");
  } catch (err) {
    console.log(`  job FAIL: ${err.message}`);
  }

  console.log("\n" + "─".repeat(60));
  console.log("Next: run the ST-50 through the proxy (mode: transparent) and compare");
  console.log("sniff_logs/*_st50_status_exact.bin with proxy 'Printer → ST-50' hex dumps.");
  console.log("─".repeat(60));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
