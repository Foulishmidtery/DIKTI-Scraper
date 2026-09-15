const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const { default: pngToIco } = await import("png-to-ico");
  const source = path.join(__dirname, "assets", "kneks-icon.png");
  const target = path.join(__dirname, "assets", "kneks-icon.ico");
  if (!fs.existsSync(source)) throw new Error("Logo KNEKS untuk ikon aplikasi tidak ditemukan.");
  const icon = await pngToIco(source);
  fs.writeFileSync(target, icon);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
