const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { flipFuses, FuseVersion, FuseV1Options } = require("@electron/fuses");
const { readAsarHeader } = require("app-builder-lib/out/asar/asar");
const { signFiles } = require("./sign-utils.cjs");

async function applyWindowsMetadata(executable, context) {
  const { rcedit } = await import("rcedit");
  const icon = path.join(__dirname, "assets", "kneks-icon.ico");
  await rcedit(executable, {
    icon,
    "file-version": context.packager.appInfo.version,
    "product-version": context.packager.appInfo.version,
    "version-string": {
      CompanyName: "KNEKS",
      FileDescription: "PDDIKTI Scraper",
      InternalName: "PDDIKTI Scraper",
      LegalCopyright: "KNEKS",
      OriginalFilename: "PDDIKTI Scraper.exe",
      ProductName: "PDDIKTI Scraper",
    },
    "requested-execution-level": "asInvoker",
  });
}

async function hardenExecutable(executable, appOutDir) {
  const asarPath = path.join(appOutDir, "resources", "app.asar");
  const { header } = await readAsarHeader(asarPath);
  const payload = Buffer.from(JSON.stringify([{
    file: "resources\\app.asar",
    alg: "SHA256",
    value: crypto.createHash("sha256").update(header).digest("hex"),
  }]), "utf8");

  const embedScript = path.join(__dirname, "embed-asar-integrity.ps1");
  let embedded = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    embedded = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", embedScript,
      "-Executable", executable,
      "-PayloadBase64", payload.toString("base64"),
    ], { windowsHide: true, stdio: "inherit" });
    if (embedded.status === 0) break;
    await new Promise((resolve) => setTimeout(resolve, attempt * 1200));
  }
  if (embedded?.status !== 0) throw new Error("Gagal menyematkan ASAR integrity ke executable setelah 5 percobaan.");

  await flipFuses(executable, {
    version: FuseVersion.V1,
    strictlyRequireAllFuses: true,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    [FuseV1Options.WasmTrapHandlers]: true,
  });
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;

  const productName = context.packager.appInfo.productFilename;
  const candidates = [
    path.join(context.appOutDir, `${productName}.exe`),
    path.join(context.appOutDir, "resources", "backend", "pddikti-backend.exe"),
  ];
  const files = candidates.filter((file) => fs.existsSync(file));
  if (files.length !== candidates.length) throw new Error("Executable aplikasi yang akan ditandatangani tidak lengkap.");

  await applyWindowsMetadata(candidates[0], context);
  await hardenExecutable(candidates[0], context.appOutDir);
  await signFiles(files);
};
