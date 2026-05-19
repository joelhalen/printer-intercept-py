/**
 * Printer reachability probe — mimics checks embedded devices often perform.
 *
 * Usage:
 *   node diagnose.js 10.3.25.25
 *   node diagnose.js 10.3.25.25 9100
 */

const net = require("net");

const host = process.argv[2];
const port = parseInt(process.argv[3] || "9100", 10);

if (!host) {
  console.error("Usage: node diagnose.js <host> [port]");
  process.exit(1);
}

const CRLF = "\r\n";

const PJL_PROBES = [
  { name: "INFO ID", bytes: `@PJL INFO ID${CRLF}` },
  { name: "INFO STATUS", bytes: `@PJL INFO STATUS${CRLF}` },
  { name: "INFO CONFIG", bytes: `@PJL INFO CONFIG${CRLF}` },
];

function tcpConnect(ms = 5000) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`TCP connect timed out after ${ms}ms`));
    }, ms);

    socket.connect(port, host, () => {
      clearTimeout(timer);
      resolve(socket);
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function sendAndCollect(socket, payload, waitMs = 2000) {
  return new Promise((resolve) => {
    const chunks = [];
    const onData = (c) => chunks.push(c);

    socket.on("data", onData);

    socket.write(payload, () => {
      setTimeout(() => {
        socket.removeListener("data", onData);
        resolve(Buffer.concat(chunks));
      }, waitMs);
    });
  });
}

async function main() {
  console.log("═".repeat(60));
  console.log(`Printer probe: ${host}:${port}`);
  console.log("═".repeat(60));

  // ── 1. TCP connect ──
  console.log("\n[1] TCP connect (port 9100 / JetDirect)...");
  let socket;
  try {
    socket = await tcpConnect();
    console.log("    OK — TCP connection established.");
  } catch (err) {
    console.log(`    FAIL — ${err.message}`);
    console.log("\n    If this fails from the proxy PC too, nothing is listening on that port.");
    console.log("    If this works from your laptop but ST-50 still fails, check routing/VLAN/firewall.");
    process.exit(1);
  }

  // ── 2. PJL probes (many devices use these to decide "printer found") ──
  console.log("\n[2] PJL identity probes (devices often require a response)...");
  for (const probe of PJL_PROBES) {
    const response = await sendAndCollect(socket, probe.bytes);
    const text = response.toString("latin1").trim();
    if (response.length === 0) {
      console.log(`    ${probe.name}: (no response — host accepted data but sent nothing back)`);
    } else {
      const preview = text.length > 200 ? text.slice(0, 200) + "…" : text;
      console.log(`    ${probe.name}: ${response.length} bytes`);
      console.log(`      ${preview.replace(/\r?\n/g, "\n      ")}`);
    }
  }

  socket.end();

  // ── 3. Minimal PostScript job (like a short print) ──
  console.log("\n[3] Minimal PostScript job (raw print path)...");
  try {
    const psSocket = await tcpConnect();
    const job = "%!PS-Adobe-3.0\r\n(Diagnose) show\r\n\x0c";
    await sendAndCollect(psSocket, job, 500);
    psSocket.end();
    console.log("    OK — job bytes sent (check proxy logs / captured_jobs if targeting the proxy).");
  } catch (err) {
    console.log(`    FAIL — ${err.message}`);
  }

  console.log("\n" + "─".repeat(60));
  console.log("Interpretation:");
  console.log("  • TCP OK + PJL responses  → Real printer (or PJL-aware proxy). ST-50 may accept this.");
  console.log("  • TCP OK + PJL silent     → Raw listener only (current proxy). ST-50 may show 'not found'.");
  console.log("  • TCP FAIL from ST-50 net → Fix IP, port, firewall, or VLAN — not a PJL issue.");
  console.log("─".repeat(60));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
