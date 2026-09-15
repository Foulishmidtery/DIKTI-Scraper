const { contextBridge } = require("electron");

const apiArgument = process.argv.find((value) => value.startsWith("--pddikti-api="));
const tokenArgument = process.argv.find((value) => value.startsWith("--pddikti-local-session="));
const apiBaseUrl = apiArgument ? apiArgument.slice("--pddikti-api=".length) : "";
const localToken = tokenArgument ? tokenArgument.slice("--pddikti-local-session=".length) : "";
const controllers = new Map();

const base = new URL(apiBaseUrl);
if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || !base.port || localToken.length < 40) {
  throw new Error("Invalid local API bootstrap");
}

const rules = [
  ["GET", /^\/api\/(health|target-prodi|outputs|analytics)$/],
  ["GET", /^\/api\/scrape-runs\?limit=\d{1,3}$/],
  ["GET", /^\/api\/stream\/[0-9a-f-]{36}$/i],
  ["GET", /^\/api\/(download|analyze)\/[A-Za-z0-9_.%()-]{1,255}$/],
  ["POST", /^\/api\/(session|run-scraper|export)$/],
  ["POST", /^\/api\/analytics\/(dosen|prodi)-detail$/],
  ["POST", /^\/api\/stop-scraper\/[0-9a-f-]{36}$/i],
  ["DELETE", /^\/api\/session$/],
  ["DELETE", /^\/api\/delete-file\/[A-Za-z0-9_.%()-]{1,255}$/],
];

function allowed(method, path) {
  return rules.some(([ruleMethod, pattern]) => ruleMethod === method && pattern.test(path));
}

function checked(methodValue, pathValue, body) {
  const method = String(methodValue || "GET").toUpperCase();
  const requestPath = String(pathValue || "");
  if (!allowed(method, requestPath)) throw new Error("Permintaan lokal ditolak.");
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  if (serialized && Buffer.byteLength(serialized, "utf8") > 128 * 1024) throw new Error("Payload lokal terlalu besar.");
  return { method, requestPath, serialized };
}

async function localFetch(methodValue, pathValue, body, signal) {
  const { method, requestPath, serialized } = checked(methodValue, pathValue, body);
  return fetch(`${apiBaseUrl}${requestPath}`, {
    method,
    body: serialized,
    signal,
    redirect: "error",
    credentials: "omit",
    headers: {
      "X-Local-Session": localToken,
      ...(serialized ? { "Content-Type": "application/json" } : {}),
    },
  });
}

async function request(method, requestPath, body) {
  const response = await localFetch(method, requestPath, body);
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : `Permintaan gagal (${response.status})`);
  return result;
}

async function streamJob(jobId, listener) {
  const id = String(jobId || "");
  if (!/^[0-9a-f-]{36}$/i.test(id) || typeof listener !== "function") throw new Error("Job tidak valid.");
  controllers.get(id)?.abort();
  const controller = new AbortController();
  controllers.set(id, controller);
  const response = await localFetch("GET", `/api/stream/${id}`, undefined, controller.signal);
  if (!response.ok || !response.body) throw new Error("Stream job tidak tersedia.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
        if (data && data.length <= 128 * 1024) listener(JSON.parse(data));
      }
    }
  } finally {
    controllers.delete(id);
    reader.releaseLock();
  }
}

function cancelStream(jobId) {
  const id = String(jobId || "");
  controllers.get(id)?.abort();
  controllers.delete(id);
}

async function download(filename) {
  const safe = encodeURIComponent(String(filename || ""));
  if (!/^[A-Za-z0-9_.%()-]{1,255}$/.test(safe)) throw new Error("Nama file tidak valid.");
  const response = await localFetch("GET", `/api/download/${safe}`);
  const statedSize = Number(response.headers.get("content-length") || "0");
  if (!response.ok || statedSize > 100 * 1024 * 1024) throw new Error("File tidak dapat diunduh.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 100 * 1024 * 1024) throw new Error("File terlalu besar.");
  return { bytes, mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
}

contextBridge.exposeInMainWorld("desktopApi", Object.freeze({ request, streamJob, cancelStream, download }));
