// Run with: node --test
const test = require("node:test");
const assert = require("node:assert");
const net = require("net");

global.__config = { logLevel: "quiet" };

const keepAlive = require("../printer-keepalive");
const { handleIntercept, relayProbeForReply, forwardToPrinter, GENUINE_READY_STATUS } = require("../proxy");

const ST50_PROBE = keepAlive.ST50_STATUS_PROBE;
// What the Xerox B310 sends back (sniff_logs/*_st50_status_exact.bin).
const XEROX_STATUS = Buffer.from('@PJL INFO STATUS\nCODE=10001\nDISPLAY="Ready"\nONLINE=TRUE\n\f', "latin1");

const noSleep = () => Promise.resolve();

test("active hours: empty spec is always on", () => {
  assert.equal(keepAlive.isWithinActiveHours("", new Date(2026, 0, 1, 3, 0)), true);
});

test("active hours: daytime window", () => {
  const spec = "05:00-23:00";
  assert.equal(keepAlive.isWithinActiveHours(spec, new Date(2026, 0, 1, 4, 59)), false);
  assert.equal(keepAlive.isWithinActiveHours(spec, new Date(2026, 0, 1, 5, 0)), true);
  assert.equal(keepAlive.isWithinActiveHours(spec, new Date(2026, 0, 1, 22, 59)), true);
  assert.equal(keepAlive.isWithinActiveHours(spec, new Date(2026, 0, 1, 23, 0)), false);
});

test("active hours: window wrapping midnight", () => {
  const spec = "22:00-06:00";
  assert.equal(keepAlive.isWithinActiveHours(spec, new Date(2026, 0, 1, 23, 30)), true);
  assert.equal(keepAlive.isWithinActiveHours(spec, new Date(2026, 0, 1, 5, 0)), true);
  assert.equal(keepAlive.isWithinActiveHours(spec, new Date(2026, 0, 1, 12, 0)), false);
});

test("probe kind ignores UEL framing", () => {
  assert.equal(keepAlive.probeKind(ST50_PROBE), "STATUS");
  assert.equal(keepAlive.probeKind(Buffer.from("@PJL INFO STATUS\r\n")), "STATUS");
  assert.equal(keepAlive.probeKind(Buffer.from("@PJL INFO ID\r\n@PJL INFO CONFIG\r\n")), "CONFIG+ID");
});

test("cached reply expires", () => {
  keepAlive._reset();
  const t = { host: "10.0.0.1", port: 9100 };
  keepAlive.recordReply(t, ST50_PROBE, XEROX_STATUS);
  assert.ok(keepAlive.getCachedReply(t, Buffer.from("@PJL INFO STATUS\r\n"), 1000));
  assert.equal(keepAlive.getCachedReply(t, Buffer.from("@PJL INFO ID\r\n"), 1000), null);
  assert.equal(keepAlive.getCachedReply(t, ST50_PROBE, -1), null);
});

test("forward retries while the printer refuses the connection", async () => {
  keepAlive._reset();
  const cfg = { printerHost: "10.0.0.2", printerPort: 9100, keepAlive: { forwardRetryDelaysSeconds: [1, 1, 1] } };
  let calls = 0;
  await keepAlive.forwardWithWake(Buffer.from("job"), cfg, {
    probeFn: async () => XEROX_STATUS,
    forwardFn: async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error("ECONNREFUSED"), { connected: false });
    },
    sleep: noSleep,
  });
  assert.equal(calls, 3);
});

test("forward is not retried once the printer accepted the connection", async () => {
  keepAlive._reset();
  const cfg = { printerHost: "10.0.0.3", printerPort: 9100 };
  let calls = 0;
  await assert.rejects(
    keepAlive.forwardWithWake(Buffer.from("job"), cfg, {
      probeFn: async () => XEROX_STATUS,
      forwardFn: async () => {
        calls++;
        throw Object.assign(new Error("reset mid-job"), { connected: true });
      },
      sleep: noSleep,
    }),
    /reset mid-job/
  );
  assert.equal(calls, 1);
});

test("forward gives up after the configured retries", async () => {
  keepAlive._reset();
  const cfg = { printerHost: "10.0.0.4", printerPort: 9100, keepAlive: { forwardRetryDelaysSeconds: [1, 1] } };
  let calls = 0;
  await assert.rejects(
    keepAlive.forwardWithWake(Buffer.from("job"), cfg, {
      probeFn: async () => XEROX_STATUS,
      forwardFn: async () => {
        calls++;
        throw Object.assign(new Error("ECONNREFUSED"), { connected: false });
      },
      sleep: noSleep,
    })
  );
  assert.equal(calls, 3);
});

test("wake probe is skipped when the printer answered recently", async () => {
  keepAlive._reset();
  const cfg = { printerHost: "10.0.0.5", printerPort: 9100 };
  keepAlive.recordReply(keepAlive.targetOf(cfg), ST50_PROBE, XEROX_STATUS);
  let probes = 0;
  await keepAlive.ensureAwake(cfg, async () => {
    probes++;
    return XEROX_STATUS;
  });
  assert.equal(probes, 0);
});

test("keep-alive poll skips outside active hours", async () => {
  keepAlive._reset();
  const cfg = { printerHost: "10.0.0.6", printerPort: 9100, keepAlive: { activeHours: "05:00-06:00" } };
  let probes = 0;
  const r = await keepAlive.pollTarget(cfg, async () => { probes++; return XEROX_STATUS; }, null, new Date(2026, 0, 1, 12, 0));
  assert.equal(r, "outside-hours");
  assert.equal(probes, 0);
});

// ─── Integration: a printer that is slow to answer while asleep ──────────────

/** Fake Xerox that takes `wakeMs` to answer a status probe when asleep. */
function startSleepyPrinter(wakeMs) {
  const state = { awakeUntil: 0, jobs: [] };
  const server = net.createServer((s) => {
    const chunks = [];
    s.on("data", (c) => {
      chunks.push(c);
      const text = Buffer.concat(chunks).toString("latin1");
      if (/@PJL INFO STATUS/.test(text) && !/%!PS/.test(text)) {
        const delay = Date.now() < state.awakeUntil ? 20 : wakeMs;
        setTimeout(() => {
          state.awakeUntil = Date.now() + 60000;
          if (!s.destroyed) s.write(XEROX_STATUS);
        }, delay);
      }
    });
    s.on("end", () => {
      const data = Buffer.concat(chunks);
      if (/%!PS/.test(data.toString("latin1"))) state.jobs.push(data);
      s.end();
    });
    s.on("error", () => {});
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, state }))
  );
}

function startProxy(cfg) {
  cfg.outputDir = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "proxy-test-"));
  const server = net.createServer((sock) => handleIntercept(sock, cfg));
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }))
  );
}

/** Act like the ST-50: send a status probe and time the reply. */
function st50Probe(port, giveUpMs = 3000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const s = net.connect(port, "127.0.0.1", () => s.write(ST50_PROBE));
    s.once("data", (d) => {
      resolve({ reply: d, ms: Date.now() - started });
      s.end();
    });
    s.setTimeout(giveUpMs, () => {
      resolve({ reply: null, ms: Date.now() - started });
      s.destroy();
    });
    s.on("error", () => {});
  });
}

test("sleeping printer: ST-50 probe is answered before the ST-50 gives up", async () => {
  keepAlive._reset();
  const printer = await startSleepyPrinter(4000);
  const cfg = {
    printerHost: "127.0.0.1",
    printerPort: printer.port,
    keepAlive: { probeDeadlineMs: 800 },
  };
  const proxy = await startProxy(cfg);
  try {
    const r = await st50Probe(proxy.port, 2000);
    assert.ok(r.reply, "ST-50 got no reply (would show 'printer not found')");
    assert.ok(r.ms < 1500, `reply took ${r.ms} ms`);
    assert.deepEqual(r.reply, GENUINE_READY_STATUS);
  } finally {
    proxy.server.close();
    printer.server.close();
  }
});

test("keep-alive poll caches the printer's own reply for instant answers", async () => {
  keepAlive._reset();
  const printer = await startSleepyPrinter(1500);
  const cfg = { printerHost: "127.0.0.1", printerPort: printer.port };
  const proxy = await startProxy(cfg);
  try {
    assert.equal(await keepAlive.pollTarget(cfg, relayProbeForReply), "ok");
    printer.state.awakeUntil = 0; // printer dozes off again
    const r = await st50Probe(proxy.port, 2000);
    assert.ok(r.ms < 300, `reply took ${r.ms} ms`);
    assert.deepEqual(r.reply, XEROX_STATUS);
  } finally {
    proxy.server.close();
    printer.server.close();
  }
});

test("job is delivered once a printer that was refusing connections comes up", async () => {
  keepAlive._reset();
  const printer = await startSleepyPrinter(10);
  const port = printer.port;
  await new Promise((r) => printer.server.close(r)); // printer "off"
  const cfg = {
    printerHost: "127.0.0.1",
    printerPort: port,
    keepAlive: { wakeTimeoutMs: 200, forwardRetryDelaysSeconds: [1, 1] },
  };
  setTimeout(() => printer.server.listen(port, "127.0.0.1"), 600);
  await keepAlive.forwardWithWake(Buffer.from("%!PS\nshowpage\n"), cfg, {
    forwardFn: forwardToPrinter,
    probeFn: relayProbeForReply,
  });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(printer.state.jobs.length, 1);
  printer.server.close();
});
