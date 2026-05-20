/**
 * Side-by-side probe: proxy host vs real printer.
 * Shows exactly how they differ on port 9100 (what the ST-50 likely checks).
 *
 * Usage:
 *   node compare.js 10.3.25.25 <xerox-ip>
 */

const net = require("net");

const proxyHost = process.argv[2];
const printerHost = process.argv[3];
const port = parseInt(process.argv[4] || "9100", 10);

if (!proxyHost || !printerHost) {
  console.error("Usage: node compare.js <proxy-ip> <printer-ip> [port]");
  process.exit(1);
}

const CRLF = "\r\n";
const ST50_STATUS_PROBE = Buffer.from(
  "\x1B%-12345X@PJL INFO STATUS\r\n\x1B%-12345X@PJL\r\n",
  "latin1"
);

const PROBES = [
  { name: "INFO ID", bytes: `@PJL INFO ID${CRLF}` },
  { name: "INFO STATUS", bytes: `@PJL INFO STATUS${CRLF}` },
  { name: "INFO CONFIG", bytes: `@PJL INFO CONFIG${CRLF}` },
  { name: "UEL + INFO ID", bytes: `\x1B%-12345X@PJL INFO ID${CRLF}` },
  { name: "ST-50 STATUS (exact)", bytes: ST50_STATUS_PROBE },
];

function probeHost(host) {
  return new Promise(async (resolve) => {
    const result = { host, tcp: false, probes: [], error: null };

    try {
      const socket = await new Promise((res, rej) => {
        const s = new net.Socket();
        const t = setTimeout(() => {
          s.destroy();
          rej(new Error("TCP timeout"));
        }, 5000);
        s.connect(port, host, () => {
          clearTimeout(t);
          res(s);
        });
        s.on("error", (e) => {
          clearTimeout(t);
          rej(e);
        });
      });
      result.tcp = true;

      for (const p of PROBES) {
        const response = await new Promise((res) => {
          const chunks = [];
          const onData = (c) => chunks.push(c);
          socket.on("data", onData);
          socket.write(p.bytes, () => {
            setTimeout(() => {
              socket.removeListener("data", onData);
              res(Buffer.concat(chunks));
            }, 2500);
          });
        });
        result.probes.push({
          name: p.name,
          bytes: response.length,
          text: response.toString("latin1").trim(),
        });
      }
      socket.end();
    } catch (err) {
      result.error = err.message;
    }
    resolve(result);
  });
}

function summarize(text, max = 120) {
  if (!text) return "(no response)";
  const oneLine = text.replace(/\r?\n/g, " | ");
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

async function main() {
  console.log("═".repeat(70));
  console.log(`Comparing port ${port} responses`);
  console.log(`  Proxy host : ${proxyHost}`);
  console.log(`  Real printer: ${printerHost}`);
  console.log("═".repeat(70));

  const [proxy, printer] = await Promise.all([
    probeHost(proxyHost),
    probeHost(printerHost),
  ]);

  console.log("\n── TCP connect ──");
  console.log(`  ${proxyHost.padEnd(16)} ${proxy.tcp ? "OK" : "FAIL" + (proxy.error ? ` (${proxy.error})` : "")}`);
  console.log(`  ${printerHost.padEnd(16)} ${printer.tcp ? "OK" : "FAIL" + (printer.error ? ` (${printer.error})` : "")}`);

  if (!proxy.tcp) {
    console.log("\n  Proxy host is not accepting TCP on this port.");
    console.log("  → Is node proxy.js running? Is another app using 9100?");
    console.log("  → On the intercept PC: netstat -ano | findstr :9100");
  }

  console.log("\n── PJL probe responses ──");
  for (const p of PROBES) {
    const a = proxy.probes.find((x) => x.name === p.name);
    const b = printer.probes.find((x) => x.name === p.name);
    const match =
      a && b && a.bytes > 0 && b.bytes > 0 && a.text === b.text ? "SAME" : "DIFF";

    console.log(`\n  [${p.name}]  (${match})`);
    console.log(`    Proxy  (${a?.bytes ?? 0} B): ${summarize(a?.text)}`);
    console.log(`    Printer(${b?.bytes ?? 0} B): ${summarize(b?.text)}`);
  }

  console.log("\n" + "─".repeat(70));
  console.log("What to do:");
  console.log("  • If proxy TCP fails → start proxy.js; free port 9100.");
  console.log("  • If proxy PJL silent but printer responds → set relayPjlToPrinter:true");
  console.log("    in config.json and restart proxy (forwards probes to the Xerox).");
  console.log("  • If both respond but ST-50 still fails → run proxy with ST-50 test;");
  console.log("    check console for 'New connection' and 'First bytes' log lines.");
  console.log("─".repeat(70));
}

main().catch(console.error);
