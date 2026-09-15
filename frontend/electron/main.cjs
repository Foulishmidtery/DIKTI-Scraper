const { app, BrowserWindow, dialog, Menu, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const runtimeConfig = require("./runtime-config.cjs");

// Chromium repeatedly crashes the GPU process on affected Intel Windows
// drivers. Software compositing is predictable for this SVG/DOM dashboard and
// keeps the renderer sandbox intact.
app.disableHardwareAcceleration();

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pddikti-runtime-"));
const instanceLockPath = path.join(os.tmpdir(), "kneks-pddikti-scraper-instance");
const userDataPath = path.join(runtimeRoot, "userdata");
const sessionDataPath = path.join(runtimeRoot, "session");
const crashPath = path.join(runtimeRoot, "crash");
for (const target of [instanceLockPath, userDataPath, sessionDataPath, crashPath]) fs.mkdirSync(target, { recursive: true });
// The lock path must be stable. A unique userData path here would allow every
// double-click to start another Electron/Flask stack.
app.setPath("userData", instanceLockPath);
const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) app.quit();
app.setPath("userData", userDataPath);
app.setPath("sessionData", sessionDataPath);
app.setPath("crashDumps", crashPath);
if (singleInstanceLock) {
  // Previous Chromium files can only be removed safely after the previous
  // process has fully exited. Clean them at the next successful startup.
  for (const entry of fs.readdirSync(os.tmpdir(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("pddikti-runtime-")) continue;
    const stalePath = path.join(os.tmpdir(), entry.name);
    if (path.resolve(stalePath) === path.resolve(runtimeRoot)) continue;
    try { fs.rmSync(stalePath, { recursive: true, force: true }); } catch {}
  }
}
app.commandLine.appendSwitch("disable-logging");
app.commandLine.appendSwitch("disable-breakpad");
app.commandLine.appendSwitch("renderer-process-limit", "2");

let backendProcess = null;
let localApiUrl = null;
let localSessionToken = null;
let mainSession = null;
let mainWindow = null;
let splashWindow = null;
let uiServer = null;
let uiOrigin = null;
let shutdownStarted = false;
let startupStage = "bootstrap";
let backendLaunchState = null;
let backendRestarting = false;
let backendRestartCount = 0;

function appIconPath() {
  return path.join(__dirname, "assets", "kneks-icon.png");
}

function vbLiteral(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function installPortableDesktopShortcut() {
  if (!app.isPackaged || process.platform !== "win32") return;
  try {
    const portablePath = process.env.PORTABLE_EXECUTABLE_FILE;
    const executablePath = portablePath && path.isAbsolute(portablePath) && fs.existsSync(portablePath)
      ? path.resolve(portablePath)
      : path.resolve(process.execPath);
    if (!executablePath.toLowerCase().endsWith(".exe") || !fs.statSync(executablePath).isFile()) return;

    const shortcutPath = path.resolve(app.getPath("desktop"), "PDDIKTI Scraper.lnk");
    let currentTarget = "";
    try { currentTarget = shell.readShortcutLink(shortcutPath).target; } catch {}
    const shortcutUnchanged = currentTarget && path.resolve(currentTarget).toLowerCase() === executablePath.toLowerCase();
    const taskName = "KNEKS-PDDIKTI-Scraper-Shortcut-Cleanup";
    const watchdogDirectory = path.resolve(process.env.LOCALAPPDATA || os.tmpdir(), "KNEKS", "PDDIKTI-Scraper");
    const watchdogPath = path.join(watchdogDirectory, "shortcut-cleanup.vbs");
    if (shortcutUnchanged && fs.existsSync(watchdogPath)) return;
    const shortcutCreated = shell.writeShortcutLink(shortcutPath, fs.existsSync(shortcutPath) ? "replace" : "create", {
      target: executablePath,
      cwd: path.dirname(executablePath),
      description: "PDDIKTI Scraper KNEKS",
      icon: executablePath,
      iconIndex: 0,
      appUserModelId: "id.go.kemenkeu.pddikti-scraper",
    });
    if (!shortcutCreated) return;

    fs.mkdirSync(watchdogDirectory, { recursive: true });
    fs.writeFileSync(watchdogPath, [
      "On Error Resume Next",
      "Set fso = CreateObject(\"Scripting.FileSystemObject\")",
      "Set host = CreateObject(\"WScript.Shell\")",
      `target = ${vbLiteral(executablePath)}`,
      `link = ${vbLiteral(shortcutPath)}`,
      `task = ${vbLiteral(taskName)}`,
      "If Not fso.FileExists(target) Then",
      "  If fso.FileExists(link) Then",
      "    Set currentLink = host.CreateShortcut(link)",
      "    If LCase(currentLink.TargetPath) = LCase(target) Then fso.DeleteFile link, True",
      "  End If",
      "  taskExe = host.ExpandEnvironmentStrings(\"%SystemRoot%\") & \"\\System32\\schtasks.exe\"",
      "  host.Run Chr(34) & taskExe & Chr(34) & \" /Delete /TN \" & Chr(34) & task & Chr(34) & \" /F\", 0, True",
      "  fso.DeleteFile WScript.ScriptFullName, True",
      "End If",
      "",
    ].join("\r\n"), { encoding: "utf8", mode: 0o600 });

    const wscriptPath = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe");
    const taskAction = `\"${wscriptPath}\" //B //NoLogo \"${watchdogPath}\"`;
    const task = spawn("schtasks.exe", [
      "/Create", "/TN", taskName, "/TR", taskAction,
      "/SC", "MINUTE", "/MO", "5", "/RL", "LIMITED", "/F",
    ], { windowsHide: true, stdio: "ignore" });
    task.on("exit", (code) => {
      if (code === 0) {
        try { fs.rmSync(path.join(watchdogDirectory, "shortcut-cleanup.ps1"), { force: true }); } catch {}
      } else {
        try { fs.rmSync(watchdogPath, { force: true }); } catch {}
      }
    });
    task.on("error", () => { try { fs.rmSync(watchdogPath, { force: true }); } catch {} });
  } catch {
    // Shortcut bersifat kenyamanan tambahan dan tidak boleh menghambat startup.
  }
}

function uiRootPath() {
  return path.join(__dirname, "..", "dist");
}

function gatewayUrl() {
  const raw = app.isPackaged ? runtimeConfig.gatewayUrl : (process.env.PDDIKTI_GATEWAY_URL || runtimeConfig.gatewayUrl);
  const parsed = new URL(raw);
  const insecureDev = !app.isPackaged && parsed.protocol === "http:" && ["127.0.0.1", "localhost"].includes(parsed.hostname);
  if ((!insecureDev && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Konfigurasi gateway production tidak valid.");
  }
  return parsed.origin;
}

function lockWebContents(contents) {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  if (app.isPackaged) {
    contents.on("devtools-opened", () => contents.closeDevTools());
  }
  contents.on("before-input-event", (event, input) => {
    const devtools = input.key === "F12" || ((input.control || input.meta) && input.shift && input.key.toLowerCase() === "i");
    const zoom = (input.control || input.meta) && ["+", "-", "=", "0"].includes(input.key);
    if ((app.isPackaged && devtools) || zoom) event.preventDefault();
  });
}

function createSplashWindow(uiUrl) {
  splashWindow = new BrowserWindow({
    width: 520,
    height: 340,
    frame: false,
    resizable: false,
    center: true,
    show: true,
    alwaysOnTop: true,
    backgroundColor: "#f5faf7",
    icon: appIconPath(),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: !app.isPackaged },
  });
  lockWebContents(splashWindow.webContents);
  splashWindow.show();
  splashWindow.focus();
  return splashWindow.loadURL(`${uiUrl}/splash.html`).catch((error) => {
    throw new Error("Splash aplikasi tidak dapat dimuat.", { cause: error });
  });
}

function startUiServer() {
  const root = path.resolve(uiRootPath());
  const mime = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  };
  return new Promise((resolve, reject) => {
    uiServer = http.createServer((request, response) => {
      if (!request.url || !["GET", "HEAD"].includes(request.method || "")) {
        response.writeHead(405, { Allow: "GET, HEAD" });
        return response.end();
      }
      let pathname;
      try { pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname); }
      catch { response.writeHead(400); return response.end(); }
      if (pathname === "/") pathname = "/index.html";
      const specialFiles = {
        "/splash.html": path.join(__dirname, "splash.html"),
        "/assets/kneks-logo.png": path.join(__dirname, "assets", "kneks-logo.png"),
      };
      const target = specialFiles[pathname] || path.resolve(root, `.${pathname}`);
      if (!specialFiles[pathname] && target !== root && !target.startsWith(`${root}${path.sep}`)) {
        response.writeHead(404);
        return response.end();
      }
      fs.stat(target, (statError, stats) => {
        if (statError || !stats.isFile()) {
          response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          return response.end("Not Found");
        }
        const extension = path.extname(target).toLowerCase();
        const connectSource = localApiUrl || "'none'";
        response.writeHead(200, {
          "Content-Type": mime[extension] || "application/octet-stream",
          "Content-Length": stats.size,
          "Cache-Control": extension === ".html" ? "no-store" : "public, max-age=31536000, immutable",
          "Content-Security-Policy": `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ${connectSource}; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
          "Cross-Origin-Opener-Policy": "same-origin",
          "Cross-Origin-Resource-Policy": "same-origin",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        });
        if (request.method === "HEAD") return response.end();
        const stream = fs.createReadStream(target);
        stream.on("error", () => response.destroy());
        stream.pipe(response);
      });
    });
    uiServer.once("error", reject);
    uiServer.listen(0, "127.0.0.1", () => {
      const address = uiServer.address();
      if (!address || typeof address === "string") return reject(new Error("UI lokal tidak dapat dimulai."));
      uiOrigin = `http://127.0.0.1:${address.port}`;
      resolve(uiOrigin);
    });
  });
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 5000;
      server.close(() => resolve(port));
    });
  });
}

function pythonCommand() {
  if (app.isPackaged) return { command: path.join(process.resourcesPath, "backend", "pddikti-backend.exe"), args: [] };
  const projectRoot = path.resolve(__dirname, "..", "..");
  const candidates = [process.env.PDDIKTI_PYTHON, path.resolve(projectRoot, ".venv", "Scripts", "python.exe"), path.resolve(projectRoot, "..", ".venv", "Scripts", "python.exe")].filter(Boolean);
  const command = candidates.find((candidate) => fs.existsSync(candidate)) || "py";
  return { command, args: command === "py" ? ["-3", "-m", "backend.desktop_entry"] : ["-m", "backend.desktop_entry"] };
}

async function sha256(filePath, expectedSize) {
  const source = await fs.promises.readFile(filePath);
  if (path.extname(filePath).toLowerCase() !== ".exe") {
    return crypto.createHash("sha256").update(source).digest("hex");
  }

  // Authenticode changes only the PE checksum, security-directory entry, and
  // appended certificate table. Normalize those fields so the signed packaged
  // backend still matches the manifest generated from the unsigned build.
  if (source.length < 256 || source.readUInt16LE(0) !== 0x5a4d) throw new Error("Executable backend tidak valid.");
  const peOffset = source.readUInt32LE(0x3c);
  if (peOffset + 144 > source.length || source.readUInt32LE(peOffset) !== 0x00004550) throw new Error("Executable backend tidak valid.");
  const optionalOffset = peOffset + 24;
  const magic = source.readUInt16LE(optionalOffset);
  const dataDirectoryOffset = optionalOffset + (magic === 0x10b ? 96 : magic === 0x20b ? 112 : 0);
  if (dataDirectoryOffset === optionalOffset || dataDirectoryOffset + 40 > source.length) throw new Error("Executable backend tidak valid.");
  const checksumOffset = optionalOffset + 64;
  const securityDirectoryOffset = dataDirectoryOffset + 32;
  const certificateOffset = source.readUInt32LE(securityDirectoryOffset);
  const certificateSize = source.readUInt32LE(securityDirectoryOffset + 4);
  const normalized = Buffer.from(source);
  normalized.fill(0, checksumOffset, checksumOffset + 4);
  normalized.fill(0, securityDirectoryOffset, securityDirectoryOffset + 8);
  const hash = crypto.createHash("sha256");
  if (certificateOffset > 0 && certificateSize > 0 && certificateOffset + certificateSize <= normalized.length) {
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > certificateOffset || certificateOffset + certificateSize !== normalized.length) {
      throw new Error("Struktur tanda tangan backend tidak valid.");
    }
    for (let index = expectedSize; index < certificateOffset; index += 1) {
      if (normalized[index] !== 0) throw new Error("Padding tanda tangan backend tidak valid.");
    }
    hash.update(normalized.subarray(0, expectedSize));
  } else {
    if (expectedSize !== normalized.length) throw new Error("Ukuran komponen aplikasi tidak valid.");
    hash.update(normalized);
  }
  return hash.digest("hex");
}

async function verifyBackendIntegrity() {
  if (!app.isPackaged) return;
  const manifestPath = path.join(__dirname, "integrity-manifest.json");
  const backendRoot = path.resolve(process.resourcesPath, "backend");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(manifest.files) || manifest.files.length < 1) throw new Error("Manifest integritas tidak valid.");
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== "string" || !Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("Manifest integritas tidak valid.");
    const target = path.resolve(backendRoot, entry.path);
    if (!target.startsWith(`${backendRoot}${path.sep}`) || !fs.existsSync(target) || await sha256(target, entry.size) !== entry.sha256) {
      throw new Error("Integritas komponen aplikasi tidak valid.");
    }
  }
}

function waitForBackend(url, child, token, timeoutMs = 45_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (child.exitCode !== null) return reject(new Error("Backend lokal tidak dapat dimulai."));
      const request = http.get(`${url}/api/health`, { headers: { "X-Local-Session": token } }, (response) => {
        response.resume();
        if (response.statusCode === 200 || response.statusCode === 503) resolve();
        else setTimeout(check, 350);
      });
      request.setTimeout(1_200, () => request.destroy());
      request.on("error", () => {
        if (Date.now() - started >= timeoutMs) return reject(new Error("Backend lokal tidak merespons."));
        setTimeout(check, 350);
      });
    };
    check();
  });
}

async function startBackend(port, remoteUrl, secureMode) {
  const launch = pythonCommand();
  const projectRoot = path.resolve(__dirname, "..", "..");
  const childEnvironment = { ...process.env };
  if (secureMode) {
    const blocked = new Set([
      "DATABASE_URL", "POSTGRES_HOST", "POSTGRES_PORT", "POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD", "PDDIKTI_ENV_FILE",
      "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
    ]);
    for (const name of Object.keys(childEnvironment)) if (blocked.has(name.toUpperCase())) delete childEnvironment[name];
  }
  localSessionToken = crypto.randomBytes(32).toString("base64url");
  Object.assign(childEnvironment, {
    FLASK_HOST: "127.0.0.1",
    FLASK_PORT: String(port),
    FLASK_DEBUG: "0",
    PDDIKTI_DESKTOP: "1",
    PDDIKTI_SECURE_GATEWAY: secureMode ? "1" : "0",
    PDDIKTI_GATEWAY_URL: secureMode ? remoteUrl : "",
    PDDIKTI_GATEWAY_JWT_PUBLIC_KEY: secureMode ? runtimeConfig.gatewayJwtPublicKey : "",
    PDDIKTI_DESKTOP_VERSION: runtimeConfig.desktopVersion,
    PDDIKTI_AUTH_KEY: localSessionToken,
    PDDIKTI_FRONTEND_ORIGINS: uiOrigin || "",
    PDDIKTI_OUTPUT_DIR: secureMode ? path.join(runtimeRoot, "output") : path.join(projectRoot, "output"),
    PDDIKTI_AUTO_EXPORT: secureMode ? "0" : "1",
    PDDIKTI_ALLOW_INSECURE_GATEWAY: secureMode ? "0" : (process.env.PDDIKTI_ALLOW_INSECURE_GATEWAY || "0"),
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
  });
  if (secureMode) {
    childEnvironment.TEMP = runtimeRoot;
    childEnvironment.TMP = runtimeRoot;
  }
  fs.mkdirSync(childEnvironment.PDDIKTI_OUTPUT_DIR, { recursive: true });
  backendLaunchState = {
    launch,
    cwd: app.isPackaged ? runtimeRoot : projectRoot,
    environment: childEnvironment,
  };
  backendProcess = launchBackendProcess();
  localApiUrl = `http://127.0.0.1:${port}`;
  await waitForBackend(localApiUrl, backendProcess, localSessionToken);
}

function launchBackendProcess() {
  if (!backendLaunchState) throw new Error("Konfigurasi backend lokal belum tersedia.");
  const child = spawn(backendLaunchState.launch.command, backendLaunchState.launch.args, {
    cwd: backendLaunchState.cwd,
    windowsHide: true,
    env: backendLaunchState.environment,
    stdio: app.isPackaged ? "ignore" : "inherit",
  });
  child.once("exit", () => {
    if (backendProcess === child) backendProcess = null;
    if (!shutdownStarted && mainWindow && !mainWindow.isDestroyed()) void recoverBackend();
  });
  return child;
}

async function recoverBackend() {
  if (backendRestarting || shutdownStarted || !backendLaunchState || !localApiUrl || !localSessionToken) return;
  backendRestarting = true;
  backendRestartCount += 1;
  try {
    if (backendRestartCount > 2) throw new Error("Backend lokal berhenti berulang kali.");
    await new Promise((resolve) => setTimeout(resolve, 400));
    const child = launchBackendProcess();
    backendProcess = child;
    await waitForBackend(localApiUrl, child, localSessionToken, 45_000);
  } catch (error) {
    writeStartupDiagnostic(error);
    if (backendRestartCount <= 2) {
      setTimeout(() => void recoverBackend(), 800);
    } else {
      dialog.showErrorBox("Layanan lokal berhenti", "Flask lokal tidak dapat dipulihkan. Silakan buka ulang aplikasi.");
      shutdownStarted = true;
      await secureShutdown();
    }
  } finally {
    backendRestarting = false;
  }
}

async function createWindow(uiUrl) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    backgroundColor: "#f7f8fa",
    icon: appIconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      additionalArguments: [`--pddikti-api=${localApiUrl}`, `--pddikti-local-session=${localSessionToken}`],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
      webSecurity: true,
      allowRunningInsecureContent: false,
      backgroundThrottling: true,
      partition: "pddikti-temporary",
    },
  });
  mainSession = mainWindow.webContents.session;
  mainSession.setSpellCheckerEnabled(false);
  lockWebContents(mainWindow.webContents);
  mainWindow.webContents.setZoomFactor(0.8);
  mainWindow.webContents.setVisualZoomLevelLimits(1, 1);
  let mainShown = false;
  const showMainWindow = () => {
    if (mainShown || !mainWindow || mainWindow.isDestroyed()) return;
    mainShown = true;
    splashWindow?.close();
    splashWindow = null;
    mainWindow.center();
    mainWindow.show();
    mainWindow.restore();
    mainWindow.focus();
    mainWindow.moveTop();
  };

  mainWindow.once("ready-to-show", showMainWindow);
  mainWindow.once("closed", () => { mainWindow = null; });
  await mainWindow.loadURL(uiUrl);
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  showMainWindow();
}

function revokeLocalSession() {
  if (!localApiUrl || !localSessionToken) return Promise.resolve();
  return new Promise((resolve) => {
    const request = http.request(`${localApiUrl}/api/session`, { method: "DELETE", timeout: 3000, headers: { "X-Local-Session": localSessionToken } }, (response) => {
      response.resume();
      response.on("end", resolve);
    });
    request.on("error", resolve);
    request.on("timeout", () => { request.destroy(); resolve(); });
    request.end();
  });
}

function stopBackend() {
  if (!backendProcess || backendProcess.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(backendProcess.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
  else backendProcess.kill();
  backendProcess = null;
}

function stopUiServer() {
  if (!uiServer) return Promise.resolve();
  const server = uiServer;
  uiServer = null;
  try { server.closeIdleConnections?.(); } catch {}
  try { server.closeAllConnections?.(); } catch {}
  return Promise.race([
    new Promise((resolve) => server.close(() => resolve())),
    new Promise((resolve) => setTimeout(resolve, 500)),
  ]);
}

function cleanupRuntime() {
  const resolved = path.resolve(runtimeRoot);
  const tempRoot = path.resolve(os.tmpdir());
  if (path.dirname(resolved) === tempRoot && path.basename(resolved).startsWith("pddikti-runtime-")) {
    try { fs.rmSync(resolved, { recursive: true, force: true }); } catch {}
  }
}

function writeStartupDiagnostic(error) {
  if (process.env.PDDIKTI_DIAGNOSTIC_STARTUP !== "1") return;
  const detail = error instanceof Error ? error.stack || error.message : String(error);
  fs.writeFileSync(
    path.join(os.tmpdir(), "pddikti-startup-diagnostic.txt"),
    `${new Date().toISOString()}\nstage=${startupStage}\n${detail}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

async function secureShutdown() {
  // A locked Chromium cache or open keep-alive connection must never leave a
  // headless Electron process behind after the window is closed.
  const forceExit = setTimeout(() => app.exit(0), 5_000);
  forceExit.unref();
  try {
    await revokeLocalSession();
    stopBackend();
    await stopUiServer();
    localSessionToken = null;
    mainSession = null;
    cleanupRuntime();
  } finally {
    clearTimeout(forceExit);
    app.exit(0);
  }
}

app.on("second-instance", () => {
  const target = mainWindow || splashWindow;
  if (!target || target.isDestroyed()) {
    // Recover automatically if Windows retained a headless main process while
    // the user clicked the launcher again.
    if (!shutdownStarted) {
      shutdownStarted = true;
      app.releaseSingleInstanceLock();
      app.relaunch();
      app.exit(0);
    }
    return;
  }
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
});

if (singleInstanceLock) app.whenReady().then(async () => {
  try {
    app.setAppUserModelId("id.go.kemenkeu.pddikti-scraper");
    Menu.setApplicationMenu(null);
    startupStage = "start-ui";
    const uiUrl = await startUiServer();
    startupStage = "create-splash";
    await createSplashWindow(uiUrl);
    startupStage = "verify-integrity";
    await verifyBackendIntegrity();
    const secureMode = app.isPackaged || process.env.PDDIKTI_SECURE_GATEWAY === "1";
    const remoteUrl = secureMode ? gatewayUrl() : "";
    const port = await findFreePort();
    startupStage = "start-services";
    await startBackend(port, remoteUrl, secureMode);
    startupStage = "create-window";
    await createWindow(uiUrl);
    setImmediate(installPortableDesktopShortcut);
    startupStage = "ready";
  } catch (error) {
    writeStartupDiagnostic(error);
    splashWindow?.close();
    dialog.showErrorBox("PDDIKTI Scraper gagal dimulai", "Komponen aplikasi atau secure gateway belum siap. Hubungi administrator.");
    await secureShutdown();
  }
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  event.preventDefault();
  void secureShutdown();
});
