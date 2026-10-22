/**
 * Locate and invoke Ghostscript / LibreOffice for document → PostScript conversion.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const os = require("os");

const DEFAULT_CONVERT = {
  tempDir: "./temp/print_jobs",
  ghostscriptPath: "",
  libreOfficePath: "",
  wordComEnabled: true,
};

function mergeConvertConfig(cfg) {
  return { ...DEFAULT_CONVERT, ...(cfg && cfg.convertToPs ? cfg.convertToPs : {}) };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function findGhostscript(explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  const names =
    process.platform === "win32"
      ? ["gswin64c.exe", "gswin32c.exe", "gs.exe"]
      : ["gs", "gswin64c"];
  const dirs =
    process.platform === "win32"
      ? [
          path.join(process.env["ProgramFiles"] || "C:\\Program Files", "gs"),
          path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "gs"),
        ]
      : ["/usr/bin", "/usr/local/bin"];

  for (const base of dirs) {
    if (!fs.existsSync(base)) continue;
    try {
      for (const sub of fs.readdirSync(base)) {
        const bin = path.join(base, sub, "bin");
        for (const name of names) {
          const full = path.join(bin, name);
          if (fs.existsSync(full)) return full;
        }
      }
    } catch (_) {
      /* ignore */
    }
  }

  for (const name of names) {
    const r = spawnSync(process.platform === "win32" ? "where" : "which", [name], {
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    if (r.status === 0 && r.stdout) {
      const line = r.stdout.trim().split(/\r?\n/)[0];
      if (line && fs.existsSync(line)) return line;
    }
  }
  return null;
}

function findLibreOffice(explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  const names = process.platform === "win32" ? ["soffice.exe"] : ["soffice", "libreoffice"];
  const winPaths = [
    path.join(process.env["ProgramFiles"] || "", "LibreOffice", "program", "soffice.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "LibreOffice", "program", "soffice.exe"),
  ];
  for (const p of winPaths) {
    if (p && fs.existsSync(p)) return p;
  }
  for (const name of names) {
    const r = spawnSync(process.platform === "win32" ? "where" : "which", [name], {
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    if (r.status === 0 && r.stdout) {
      const line = r.stdout.trim().split(/\r?\n/)[0];
      if (line && fs.existsSync(line)) return line;
    }
  }
  return null;
}

function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: options.timeout || 120000,
    windowsHide: true,
    ...options,
  });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim(),
    error: r.error,
  };
}

function convertPdfViaGhostscript(gs, pdfPath, outputPs) {
  const r = run(gs, [
    "-dNOPAUSE",
    "-dBATCH",
    "-dSAFER",
    "-sDEVICE=ps2write",
    `-sOutputFile=${outputPs}`,
    pdfPath,
  ]);
  if (!r.ok || !fs.existsSync(outputPs)) {
    throw new Error(`Ghostscript failed (${r.status}): ${r.stderr || r.stdout || r.error || "unknown"}`);
  }
  return "ghostscript";
}

function convertViaLibreOffice(lo, inputPath, outDir) {
  ensureDir(outDir);
  const profileDir = path.join(os.tmpdir(), `lo_ps_${process.pid}_${Date.now()}`);
  ensureDir(profileDir);
  const userInstall =
    process.platform === "win32"
      ? `file:///${profileDir.replace(/\\/g, "/")}`
      : `file://${profileDir}`;

  const args = [
    "--headless",
    "-env:UserInstallation=" + userInstall,
    "--convert-to",
    "ps",
    "--outdir",
    outDir,
    inputPath,
  ];

  const r =
    process.platform === "win32"
      ? run(lo, args, { timeout: 180000 })
      : run(lo, args, {
          timeout: 180000,
          env: { ...process.env, HOME: profileDir },
        });
  try {
    fs.rmSync(profileDir, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }

  const base = path.basename(inputPath, path.extname(inputPath)) + ".ps";
  const expected = path.join(outDir, base);
  if (!r.ok || !fs.existsSync(expected)) {
    throw new Error(`LibreOffice failed (${r.status}): ${r.stderr || r.stdout || "no output .ps"}`);
  }
  return { path: expected, method: "libreoffice" };
}

function convertDocxViaWordPdf(gs, docxPath, tempDir) {
  const scriptPath = path.join(__dirname, "scripts", "word-export-pdf.ps1");
  if (!fs.existsSync(scriptPath)) {
    throw new Error("word-export-pdf.ps1 not found");
  }
  const pdfPath = path.join(tempDir, path.basename(docxPath, ".docx") + ".pdf");
  const r = run(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, docxPath, pdfPath],
    { timeout: 120000 }
  );
  if (!r.ok || !fs.existsSync(pdfPath)) {
    throw new Error(`Word COM → PDF failed: ${r.stderr || r.stdout || r.error || "unknown"}`);
  }
  const outputPs = path.join(tempDir, path.basename(docxPath, ".docx") + ".ps");
  convertPdfViaGhostscript(gs, pdfPath, outputPs);
  try {
    fs.unlinkSync(pdfPath);
  } catch (_) {
    /* ignore */
  }
  return { path: outputPs, method: "word-com+ghostscript" };
}

module.exports = {
  DEFAULT_CONVERT,
  mergeConvertConfig,
  ensureDir,
  findGhostscript,
  findLibreOffice,
  convertPdfViaGhostscript,
  convertViaLibreOffice,
  convertDocxViaWordPdf,
};
