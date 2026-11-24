import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultStateDirectory,
  detectRuntime,
  inspectSourceSession,
  runAppJson,
} from "./runtime.mjs";
import { resolveSource } from "./sources/index.mjs";
import { JsonlFollower, resolveTranscript, transcriptLabel } from "./transcripts.mjs";

const MAX_ITEMS = 100;
const MAX_RENDERED = 16;
const CSP =
  "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'";

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function tokenEquals(expected, received) {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(received || ""), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function buildHtml({ basePath, sourceLabel, targetId }) {
  const title = `${sourceLabel} preview · ${targetId}`;
  const baseJson = JSON.stringify(basePath);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root {
    color-scheme: dark light;
    --bg: #111317;
    --bar: #181b21;
    --border: #2a2f3a;
    --fg: #e7ebf0;
    --muted: #9aa3b2;
    --accent: #5b8def;
    --error: #f87171;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f6f7f9;
      --bar: #ffffff;
      --border: #d8dee6;
      --fg: #181b21;
      --muted: #5d6675;
      --accent: #2563eb;
      --error: #dc2626;
    }
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    height: 100%;
    background: var(--bg);
    color: var(--fg);
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    overflow: hidden;
    user-select: none;
  }
  .shell {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    background: var(--bar);
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .title { font-weight: 600; }
  .meta { color: var(--muted); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .controls { display: flex; gap: 6px; align-items: center; }
  button {
    background: transparent;
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 3px 8px;
    font: inherit;
    cursor: pointer;
  }
  button:hover { border-color: var(--accent); color: var(--accent); }
  main {
    flex: 1;
    position: relative;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: grab;
  }
  main.dragging { cursor: grabbing; }
  #stage {
    transform-origin: center center;
    max-width: 96%;
    max-height: 96%;
    display: none;
    pointer-events: none;
  }
  #status {
    max-width: 640px;
    padding: 20px;
    white-space: pre-wrap;
    color: var(--muted);
    text-align: center;
  }
  #status.error { color: var(--error); text-align: left; font-family: ui-monospace, monospace; }
</style>
</head>
<body>
<div class="shell">
  <header>
    <span class="title">${escapeHtml(sourceLabel)}</span>
    <span class="meta" id="meta">Connecting…</span>
    <div class="controls">
      <button id="prev" title="Previous (p)">Prev</button>
      <button id="next" title="Next (n)">Next</button>
      <button id="zoom-out" title="Zoom out (-)">-</button>
      <button id="zoom-reset" title="Reset view (0)">100%</button>
      <button id="zoom-in" title="Zoom in (+)">+</button>
      <button id="rerender" title="Rerender (r)">Rerender</button>
    </div>
  </header>
  <main id="viewport">
    <img id="stage" alt="${escapeHtml(sourceLabel)} preview">
    <div id="status">Watching transcript…</div>
  </main>
</div>
<script>
const BASE = ${baseJson};
const meta = document.getElementById("meta");
const stage = document.getElementById("stage");
const statusEl = document.getElementById("status");
const viewport = document.getElementById("viewport");
const zoomResetBtn = document.getElementById("zoom-reset");

let state = { items: [], selectedHash: null, sessionLabel: "locating session", error: null, rendering: false };
let selectedHash = null;
let followLatest = true;
let zoom = 1;
let panX = 0;
let panY = 0;
let drag = null;
let imageVersion = 0;

function applyTransform() {
  stage.style.transform = \`translate(\${panX}px, \${panY}px) scale(\${zoom})\`;
  zoomResetBtn.textContent = \`\${Math.round(zoom * 100)}%\`;
}

function resetView() {
  zoom = 1;
  panX = 0;
  panY = 0;
  applyTransform();
}

function selectedIndex() {
  if (!state.items.length) return -1;
  const idx = state.items.findIndex((item) => item.hash === selectedHash);
  return idx >= 0 ? idx : state.items.length - 1;
}

function render(forceReload = false) {
  const idx = selectedIndex();
  const item = idx >= 0 ? state.items[idx] : null;
  const count = item ? \`\${idx + 1}/\${state.items.length}\` : "0/0";
  meta.textContent = \`\${count} · \${item ? item.type : state.sessionLabel} · \${state.sessionLabel}\`;

  if (!item) {
    stage.style.display = "none";
    statusEl.style.display = "block";
    statusEl.className = state.error ? "error" : "";
    statusEl.textContent = state.error || \`Watching \${state.sessionLabel}…\`;
    return;
  }

  if (item.error) {
    stage.style.display = "none";
    statusEl.style.display = "block";
    statusEl.className = "error";
    statusEl.textContent = \`Render failed:\\n\${item.error}\`;
    return;
  }

  if (!item.ready) {
    stage.style.display = "none";
    statusEl.style.display = "block";
    statusEl.className = "";
    statusEl.textContent = "Rendering…";
    return;
  }

  const nextUrl = \`\${BASE}/item/\${encodeURIComponent(item.hash)}.png?v=\${forceReload ? ++imageVersion : item.version}\`;
  if (stage.dataset.url !== nextUrl) {
    stage.dataset.url = nextUrl;
    stage.src = nextUrl;
  }
  statusEl.style.display = "none";
  stage.style.display = "block";
  applyTransform();
}

function applySnapshot(next) {
  const prevLen = state.items.length;
  state = next;
  if (!state.items.length) {
    selectedHash = null;
    followLatest = true;
  } else if (followLatest || state.items.length > prevLen || !state.items.some((i) => i.hash === selectedHash)) {
    selectedHash = state.items[state.items.length - 1].hash;
    followLatest = true;
    resetView();
  }
  render();
}

function step(delta) {
  if (!state.items.length) return;
  const nextIdx = (selectedIndex() + delta + state.items.length) % state.items.length;
  selectedHash = state.items[nextIdx].hash;
  followLatest = nextIdx === state.items.length - 1;
  resetView();
  render();
}

async function rerender() {
  const idx = selectedIndex();
  if (idx < 0) return;
  const item = state.items[idx];
  await fetch(\`\${BASE}/rerender/\${encodeURIComponent(item.hash)}\`, { method: "POST" });
  render(true);
}

document.getElementById("prev").addEventListener("click", () => step(-1));
document.getElementById("next").addEventListener("click", () => step(1));
document.getElementById("zoom-in").addEventListener("click", () => { zoom = Math.min(16, zoom * 1.25); applyTransform(); });
document.getElementById("zoom-out").addEventListener("click", () => { zoom = Math.max(0.25, zoom / 1.25); applyTransform(); });
zoomResetBtn.addEventListener("click", resetView);
document.getElementById("rerender").addEventListener("click", () => void rerender());

viewport.addEventListener("wheel", (e) => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  zoom = Math.min(16, Math.max(0.25, zoom * factor));
  applyTransform();
}, { passive: false });

viewport.addEventListener("pointerdown", (e) => {
  drag = { x: e.clientX - panX, y: e.clientY - panY };
  viewport.classList.add("dragging");
  viewport.setPointerCapture(e.pointerId);
});
viewport.addEventListener("pointermove", (e) => {
  if (!drag) return;
  panX = e.clientX - drag.x;
  panY = e.clientY - drag.y;
  applyTransform();
});
viewport.addEventListener("pointerup", () => { drag = null; viewport.classList.remove("dragging"); });

window.addEventListener("keydown", (e) => {
  if (e.key === "+" || e.key === "=") { zoom = Math.min(16, zoom * 1.25); applyTransform(); }
  else if (e.key === "-" || e.key === "_") { zoom = Math.max(0.25, zoom / 1.25); applyTransform(); }
  else if (e.key === "0") resetView();
  else if (e.key === "n" || e.key === "]" || e.key === "ArrowRight") step(1);
  else if (e.key === "p" || e.key === "[" || e.key === "ArrowLeft") step(-1);
  else if (e.key === "r") void rerender();
});

const events = new EventSource(\`\${BASE}/events\`);
events.addEventListener("state", (e) => applySnapshot(JSON.parse(e.data)));
fetch(\`\${BASE}/state\`).then((r) => r.json()).then(applySnapshot).catch(() => {});
</script>
</body>
</html>`;
}

export async function createBrowserPreviewServer({
  cacheDirectory,
  idleTimeoutMs = 15_000,
  inspectSession,
  initialConnectTimeoutMs = 60_000,
  onIdleClose = null,
  pluginRoot,
  pollIntervalMs = 2_000,
  source,
  sourceName,
  targetId,
}) {
  const token = randomBytes(24).toString("base64url");
  const basePath = `/${token}`;

  let closed = false;
  let currentSessionKey = null;
  let follower = null;
  let items = [];
  let lastError = null;
  let rendered = new Map();
  let renderErrors = new Map();
  let renderVersions = new Map();
  let seenHashes = new Set();
  let seenRecordIds = new Set();
  let sessionLabel = "locating session";
  let everConnected = false;
  let idleTimer = null;
  const sseClients = new Set();

  function snapshot() {
    return {
      error: lastError,
      items: items.map((item) => ({
        error: renderErrors.get(item.hash) || null,
        hash: item.hash,
        ready: rendered.has(item.hash),
        type: item.type,
        version: renderVersions.get(item.hash) || 1,
      })),
      sessionLabel,
      sourceName,
      targetId,
    };
  }

  function broadcast() {
    const payload = `event: state\ndata: ${JSON.stringify(snapshot())}\n\n`;
    for (const response of sseClients) {
      try {
        response.write(payload);
      } catch {
        sseClients.delete(response);
      }
    }
  }

  function armIdleTimer(ms) {
    if (!onIdleClose || ms <= 0) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (sseClients.size === 0 && !closed) onIdleClose();
    }, ms);
  }

  function forget(count) {
    const dropped = items.splice(0, count);
    for (const item of dropped) {
      rendered.delete(item.hash);
      renderErrors.delete(item.hash);
      renderVersions.delete(item.hash);
    }
  }

  function cacheRendered(hash, bytes) {
    rendered.set(hash, bytes);
    for (const key of [...rendered.keys()].slice(0, rendered.size - MAX_RENDERED)) {
      rendered.delete(key);
    }
  }

  async function renderItem(item, { force = false } = {}) {
    if (!item) return;
    if (!force && rendered.has(item.hash)) return;
    renderErrors.delete(item.hash);
    try {
      const result = await source.render(item, { cacheDirectory, pluginRoot });
      cacheRendered(item.hash, result.bytes);
      renderVersions.set(item.hash, (renderVersions.get(item.hash) || 0) + 1);
    } catch (error) {
      renderErrors.set(item.hash, String(error.message || error));
    }
    broadcast();
  }

  function addRecord(record) {
    if (seenRecordIds.has(record.id)) return;
    seenRecordIds.add(record.id);

    const added = [];
    for (const item of source.extract(record)) {
      if (seenHashes.has(item.hash)) continue;
      seenHashes.add(item.hash);
      items.push(item);
      added.push(item);
    }
    if (added.length === 0) return;
    if (items.length > MAX_ITEMS) forget(items.length - MAX_ITEMS);
    broadcast();
    for (const item of added) void renderItem(item);
  }

  async function adoptSession({ agent, sessionId, sessionPath }) {
    if (!agent) {
      throw new Error(`No Claude Code or Codex agent detected in terminal ${targetId}`);
    }
    if (agent !== "codex" && agent !== "claude") {
      throw new Error(`Preview supports Codex and Claude Code, not ${agent}`);
    }
    if (!sessionId) {
      throw new Error(`Waiting for a ${agent} session transcript in terminal ${targetId}`);
    }

    const key = `${agent}:${sessionId}`;
    if (key === currentSessionKey) return;
    const transcript = await resolveTranscript({ agent, sessionId, sessionPath });
    if (!transcript) throw new Error(`Waiting for the ${agent} session transcript to appear`);

    follower?.close();
    currentSessionKey = key;
    sessionLabel = `${agent} · ${transcriptLabel(transcript)}`;
    items = [];
    rendered = new Map();
    renderErrors = new Map();
    renderVersions = new Map();
    seenHashes = new Set();
    seenRecordIds = new Set();
    lastError = null;
    broadcast();

    follower = new JsonlFollower(transcript, agent);
    follower.on("record", addRecord);
    follower.on("error", (error) => {
      lastError = String(error.message || error);
      broadcast();
    });
    await follower.start();
  }

  async function refreshSession() {
    if (closed) return;
    try {
      const identity = await inspectSession();
      await adoptSession(identity);
    } catch (error) {
      lastError = String(error.message || error);
      broadcast();
    }
  }

  const server = createServer((req, res) => {
    const port = server.address()?.port;
    const expectedIp = `127.0.0.1:${port}`;
    const expectedLh = `localhost:${port}`;
    const host = req.headers.host;
    if (host !== expectedIp && host !== expectedLh) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("Host must be this loopback endpoint");
      return;
    }
    const origin = req.headers.origin;
    if (origin && origin !== `http://${expectedIp}` && origin !== `http://${expectedLh}`) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("Cross-origin access refused");
      return;
    }

    const url = new URL(req.url || "/", `http://${expectedIp}`);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length === 0 || !tokenEquals(token, segments[0])) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const rest = `/${segments.slice(1).join("/")}`;
    const commonHeaders = {
      "cache-control": "no-store",
      "content-security-policy": CSP,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    };

    if (req.method === "GET" && (rest === "/" || rest === "")) {
      const html = buildHtml({ basePath, sourceLabel: source.label, targetId });
      res.writeHead(200, { ...commonHeaders, "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.method === "GET" && rest === "/state") {
      res.writeHead(200, { ...commonHeaders, "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(snapshot()));
      return;
    }

    if (req.method === "GET" && rest === "/events") {
      res.writeHead(200, {
        ...commonHeaders,
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
      });
      res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
      everConnected = true;
      clearTimeout(idleTimer);
      sseClients.add(res);
      req.on("close", () => {
        sseClients.delete(res);
        if (sseClients.size === 0) armIdleTimer(idleTimeoutMs);
      });
      return;
    }

    if (req.method === "GET" && rest.startsWith("/item/") && rest.endsWith(".png")) {
      const hash = decodeURIComponent(rest.slice("/item/".length, -".png".length));
      const bytes = rendered.get(hash);
      if (bytes) {
        res.writeHead(200, { ...commonHeaders, "content-type": "image/png" });
        res.end(bytes);
        return;
      }
      const item = items.find((entry) => entry.hash === hash);
      if (!item) {
        res.writeHead(404, { ...commonHeaders, "content-type": "text/plain; charset=utf-8" });
        res.end("Item not found");
        return;
      }
      void renderItem(item).then(() => {
        const ready = rendered.get(hash);
        if (!ready) {
          res.writeHead(500, { ...commonHeaders, "content-type": "text/plain; charset=utf-8" });
          res.end(renderErrors.get(hash) || "Render failed");
          return;
        }
        res.writeHead(200, { ...commonHeaders, "content-type": "image/png" });
        res.end(ready);
      });
      return;
    }

    if (req.method === "POST" && rest.startsWith("/rerender/")) {
      const hash = decodeURIComponent(rest.slice("/rerender/".length));
      const item = items.find((entry) => entry.hash === hash);
      if (!item) {
        res.writeHead(404, { ...commonHeaders, "content-type": "text/plain; charset=utf-8" });
        res.end("Item not found");
        return;
      }
      void renderItem(item, { force: true }).then(() => {
        res.writeHead(200, { ...commonHeaders, "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }

    res.writeHead(404, { ...commonHeaders, "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = server.address();
  const url = `http://127.0.0.1:${port}${basePath}/`;

  await refreshSession();
  const pollTimer = pollIntervalMs > 0 ? setInterval(() => void refreshSession(), pollIntervalMs) : null;
  const heartbeatTimer = setInterval(() => {
    for (const res of sseClients) {
      try {
        res.write(": heartbeat\n\n");
      } catch {
        sseClients.delete(res);
      }
    }
  }, 20_000);
  if (!everConnected) armIdleTimer(initialConnectTimeoutMs);

  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    clearTimeout(idleTimer);
    follower?.close();
    for (const res of sseClients) {
      try {
        res.end();
      } catch {
        // Ignore already-closed client sockets.
      }
    }
    sseClients.clear();
    await new Promise((resolve) => server.close(() => resolve()));
  }

  return { close, port, refreshSession, token, url };
}

function parseCli(argv) {
  const options = { place: "tab" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--runtime" && argv[i + 1]) options.runtime = argv[++i];
    else if (arg === "--source" && argv[i + 1]) options.source = argv[++i];
    else if ((arg === "--target" || arg === "--terminal") && argv[i + 1]) options.target = argv[++i];
    else if (arg === "--place" && argv[i + 1]) options.place = argv[++i];
    else if (arg === "--space" && argv[i + 1]) options.space = argv[++i];
    else if (arg === "--pane" && argv[i + 1]) options.pane = argv[++i];
    else if (arg === "--state-dir" && argv[i + 1]) options.stateDir = argv[++i];
  }
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cli = parseCli(process.argv.slice(2));
  const runtime = detectRuntime({ explicit: cli.runtime || "browser" });
  const sourceName = cli.source || "mermaid";
  const targetId = cli.target;
  if (!targetId) {
    console.error("Browser preview requires --target <terminal>");
    process.exit(2);
  }
  const source = resolveSource(sourceName);
  const pluginRoot = process.env.HERDR_PLUGIN_ROOT || join(import.meta.dirname, "..");
  const stateDirectory = cli.stateDir || defaultStateDirectory(runtime);
  const cacheDirectory = await mkdtemp(join(tmpdir(), `herdr-${sourceName}-browser-preview-`));
  const stateKey = createHash("sha256")
    .update(`${runtime}:${targetId}:${sourceName}:browser`)
    .digest("hex")
    .slice(0, 16);
  const statePath = join(stateDirectory, `preview-${stateKey}.json`);

  let handle = null;
  let cleaned = false;

  async function cleanup(exitCode = 0) {
    if (cleaned) return;
    cleaned = true;
    await handle?.close();
    try {
      const state = JSON.parse(await readFile(statePath, "utf8"));
      if (state.pid === process.pid) await unlink(statePath);
    } catch {
      // Ignore missing or replaced state files.
    }
    await rm(cacheDirectory, { recursive: true, force: true });
    process.exit(exitCode);
  }

  handle = await createBrowserPreviewServer({
    cacheDirectory,
    inspectSession: () => inspectSourceSession({ runtime, targetId }),
    onIdleClose: () => void cleanup(0),
    pluginRoot,
    source,
    sourceName,
    targetId,
  });

  const openArgs = {
    focus: true,
    name: `${source.label} preview`,
    place: cli.place || "tab",
    profile: "person",
    url: handle.url,
  };
  if (cli.place === "right" || cli.place === "down") {
    if (cli.pane) openArgs.pane = cli.pane;
  } else if (cli.space) {
    openArgs.space = cli.space;
  }

  let opened;
  try {
    opened = await runAppJson(runtime, ["do", "browser.open", JSON.stringify(openArgs)]);
  } catch (error) {
    console.error(String(error.message || error));
    await cleanup(1);
  }

  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    statePath,
    JSON.stringify({
      mode: "browser",
      pid: process.pid,
      previewPaneId: opened?.pane || null,
      runtime,
      sourceName,
      sourceTargetId: targetId,
      url: handle.url,
    }),
    { encoding: "utf8", mode: 0o600 },
  );

  process.on("SIGINT", () => void cleanup(0));
  process.on("SIGTERM", () => void cleanup(0));
  process.on("SIGHUP", () => void cleanup(0));
}
