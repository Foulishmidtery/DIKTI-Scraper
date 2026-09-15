const fs = require("node:fs");
const path = require("node:path");
const { signFiles } = require("./sign-utils.cjs");

module.exports = async function afterAllArtifactBuild(result) {
  const installers = result.artifactPaths.filter(
    (file) => path.extname(file).toLowerCase() === ".exe" && fs.existsSync(file),
  );
  if (installers.length) await signFiles(installers);
  return [];
};
