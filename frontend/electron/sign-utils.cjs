const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { sign } = require("@electron/windows-sign");

function certificatePath(rawValue) {
  if (!rawValue) return null;
  if (rawValue.startsWith("file://")) return fileURLToPath(rawValue);
  return path.resolve(rawValue);
}

async function signFiles(files) {
  const certificateFile = certificatePath(process.env.CSC_LINK || process.env.WINDOWS_CERTIFICATE_FILE);
  if (!certificateFile) {
    if (process.env.PDDIKTI_ALLOW_UNSIGNED_BUILD === "1") return;
    throw new Error("CSC_LINK wajib diisi untuk build production.");
  }
  if (!fs.existsSync(certificateFile)) throw new Error(`Sertifikat tidak ditemukan: ${certificateFile}`);

  const certificatePassword = process.env.CSC_KEY_PASSWORD || process.env.WINDOWS_CERTIFICATE_PASSWORD;
  if (!certificatePassword) throw new Error("CSC_KEY_PASSWORD wajib diisi untuk build production.");

  for (const file of files) {
    let signed = false;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      try {
        await sign({
          files: [file],
          certificateFile,
          certificatePassword,
          hashes: ["sha256"],
          timestampServer: process.env.WINDOWS_TIMESTAMP_SERVER || "http://timestamp.digicert.com",
          description: "KNEKS PDDIKTI Scraper",
        });
        signed = true;
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const temporarilyLocked = /being used by another process|attempting to sign/i.test(message);
        if (!temporarilyLocked || attempt === 6) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 750));
      }
    }
    if (!signed) throw new Error(`Executable tidak dapat ditandatangani: ${file}`);
  }
}

module.exports = { signFiles };
