const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const runtimeConfig = require("./runtime-config.cjs");

const frontendRoot = path.resolve(__dirname, "..");
const backendRoot = path.resolve(frontendRoot, "..", "backend-dist", "pddikti-backend");
const electronDist = path.join(frontendRoot, "electron-dist");

const gateway = new URL(runtimeConfig.gatewayUrl);
if (gateway.protocol !== "https:" || gateway.hostname.includes("change-me")) {
  throw new Error("Isi gatewayUrl HTTPS production sebelum packaging.");
}
if (!/^[A-Za-z0-9_-]{50,100}$/.test(runtimeConfig.gatewayJwtPublicKey || "")) {
  throw new Error("Isi gatewayJwtPublicKey Ed25519 production sebelum packaging.");
}
if (!process.env.CSC_LINK && process.env.PDDIKTI_ALLOW_UNSIGNED_BUILD !== "1") {
  throw new Error("Code signing wajib untuk release. Set CSC_LINK atau gunakan build-portable.ps1 -UnsignedTest hanya untuk pengujian lokal.");
}
if (!fs.existsSync(backendRoot) || !fs.existsSync(electronDist)) throw new Error("Build backend/frontend belum tersedia.");

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}

function integrityHash(file) {
  const source = fs.readFileSync(file);
  if (path.extname(file).toLowerCase() !== ".exe") {
    return crypto.createHash("sha256").update(source).digest("hex");
  }
  if (source.length < 256 || source.readUInt16LE(0) !== 0x5a4d) throw new Error(`Executable backend tidak valid: ${file}`);
  const peOffset = source.readUInt32LE(0x3c);
  const optionalOffset = peOffset + 24;
  const magic = source.readUInt16LE(optionalOffset);
  const dataDirectoryOffset = optionalOffset + (magic === 0x10b ? 96 : magic === 0x20b ? 112 : 0);
  if (dataDirectoryOffset === optionalOffset || dataDirectoryOffset + 40 > source.length) throw new Error(`Executable backend tidak valid: ${file}`);
  const securityDirectoryOffset = dataDirectoryOffset + 32;
  const certificateOffset = source.readUInt32LE(securityDirectoryOffset);
  const certificateSize = source.readUInt32LE(securityDirectoryOffset + 4);
  const normalized = Buffer.from(source);
  normalized.fill(0, optionalOffset + 64, optionalOffset + 68);
  normalized.fill(0, securityDirectoryOffset, securityDirectoryOffset + 8);
  const hash = crypto.createHash("sha256");
  if (certificateOffset > 0 && certificateSize > 0 && certificateOffset + certificateSize <= normalized.length) {
    hash.update(normalized.subarray(0, certificateOffset));
    hash.update(normalized.subarray(certificateOffset + certificateSize));
  } else {
    hash.update(normalized);
  }
  return hash.digest("hex");
}

const allBackendFiles = walk(backendRoot).sort();
const rawPython = allBackendFiles.find((file) => /\.(py|pyi|pyc)$/i.test(file));
if (rawPython) throw new Error("Build backend masih membawa source/bytecode Python mentah.");

// Verify every executable/code-bearing backend artifact. PyInstaller's many
// extensionless timezone data files are not executable and opening hundreds of
// them synchronously causes a severe Windows Defender startup penalty.
const protectedExtensions = new Set([".exe", ".dll", ".pyd", ".zip", ".zi", ".pem", ".pth"]);
const backendFiles = allBackendFiles.filter((file) => protectedExtensions.has(path.extname(file).toLowerCase()));
if (!backendFiles.some((file) => path.basename(file).toLowerCase() === "pddikti-backend.exe")) {
  throw new Error("Executable backend tidak ditemukan.");
}

const sourceMaps = walk(path.join(frontendRoot, "dist")).filter((file) => file.endsWith(".map"));
if (sourceMaps.length) throw new Error("Source map production ditemukan.");

const manifest = {
  algorithm: "sha256-authenticode-normalized",
  files: backendFiles.map((file) => ({
    path: path.relative(backendRoot, file).split(path.sep).join("/"),
    size: fs.statSync(file).size,
    sha256: integrityHash(file),
  })),
};
const serialized = `${JSON.stringify(manifest)}\n`;
fs.writeFileSync(path.join(__dirname, "integrity-manifest.json"), serialized, "utf8");
fs.writeFileSync(path.join(electronDist, "integrity-manifest.json"), serialized, "utf8");
