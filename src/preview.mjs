import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractMermaidBlocks } from "./mermaid.mjs";
import { paneInfo } from "./herdr.mjs";
import {
  deleteAllKittyImages,
  encodeKittyPng,
  pngDimensions,
  zoomedImagePlacement,
} from "./kitty.mjs";
import { renderMermaid } from "./renderer.mjs";
import { JsonlFollower, resolveTranscript, transcriptLabel } from "./transcripts.mjs";

const sourcePaneId = process.env.MERMAID_SOURCE_PANE_ID;
const previewPaneId = process.env.HERDR_PANE_ID;
const pluginRoot = process.env.HERDR_PLUGIN_ROOT || join(import.meta.dirname, "..");
const stateDirectory = process.env.HERDR_PLUGIN_STATE_DIR;

if (!sourcePaneId || !previewPaneId || !stateDirectory) {
  console.error("Mermaid Preview is missing its Herdr pane context");
  process.exit(2);
}

const cacheDirectory = await mkdtemp(join(tmpdir(), "herdr-mermaid-preview-"));
const stateKey = createHash("sha256").update(sourcePaneId).digest("hex").slice(0, 16);
const statePath = join(stateDirectory, `preview-${stateKey}.json`);

let closed = false;
let currentIndex = -1;
let currentSessionKey = null;
let diagrams = [];
let follower = null;
let generation = 0;
let lastError = null;
let rendered = new Map();
let rendering = false;
let seenDiagramHashes = new Set();
let seenRecordIds = new Set();
let sessionLabel = "locating session";
let views = new Map();

const DEFAULT_VIEW = Object.freeze({ panX: 0.5, panY: 0.5, zoom: 1 });
const MAX_ZOOM = 16;
const PAN_STEP = 0.1;
const ZOOM_FACTOR = 1.25;

await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
await writeFile(
  statePath,
  JSON.stringify({ pid: process.pid, previewPaneId, sourcePaneId }),
  { encoding: "utf8", mode: 0o600 },
);

function terminalSize() {
  return {
    columns: Math.max(20, process.stdout.columns || 80),
    rows: Math.max(6, process.stdout.rows || 24),
  };
}

function truncate(text, width) {
  if (text.length <= width) return text;
  if (width <= 1) return text.slice(0, width);
  return `${text.slice(0, width - 1)}…`;
}

function currentView() {
  const diagram = diagrams[currentIndex];
  return diagram ? views.get(diagram.hash) || DEFAULT_VIEW : DEFAULT_VIEW;
}

function writeScreen({ error = null, image = null, message = null } = {}) {
  if (closed) return;
  const size = terminalSize();
  const diagram = diagrams[currentIndex];
  const view = currentView();
  const indexLabel = diagram ? `${currentIndex + 1}/${diagrams.length}` : "0/0";
  const header = truncate(
    ` Mermaid ${indexLabel} · ${diagram?.type || sessionLabel} · zoom ${view.zoom.toFixed(1)}x · source ${sourcePaneId}`,
    size.columns,
  );
  const footer = truncate(
    " +/- zoom · arrows/hjkl pan · n/p browse · 0 reset · r rerender · q close ",
    size.columns,
  );
  let output = `${deleteAllKittyImages()}\u001b[2J\u001b[H\u001b[1;36m${header}\u001b[0m\n`;

  if (image) {
    const dimensions = pngDimensions(image);
    const placement = zoomedImagePlacement(
      dimensions,
      { columns: size.columns, rows: Math.max(1, size.rows - 3) },
      view,
    );
    const imageId = Number.parseInt(diagram.hash.slice(0, 7), 16) || 1;
    output += encodeKittyPng(image, { ...placement, imageId });
  } else {
    const body = error ? `Render failed:\n${error}` : message || "Waiting for Mermaid output…";
    output += truncate(body, size.columns * Math.max(1, size.rows - 3));
  }

  output += `\u001b[${size.rows};1H\u001b[2m${footer}\u001b[0m\u001b[?25l`;
  process.stdout.write(output);
}

function showCurrent() {
  const diagram = diagrams[currentIndex];
  if (!diagram) {
    writeScreen({ message: lastError || `Watching ${sessionLabel} for a complete Mermaid fence…` });
    return;
  }
  const cached = rendered.get(diagram.hash);
  if (cached) writeScreen({ image: cached });
  else if (lastError) writeScreen({ error: lastError });
  else writeScreen({ message: rendering ? "Rendering Mermaid…" : "Preparing Mermaid…" });
}

async function renderCurrent({ force = false } = {}) {
  const diagram = diagrams[currentIndex];
  if (!diagram) return;
  if (!force && rendered.has(diagram.hash)) {
    showCurrent();
    return;
  }

  const requestedGeneration = ++generation;
  rendering = true;
  lastError = null;
  showCurrent();

  try {
    const result = await renderMermaid({
      cacheDirectory,
      hash: diagram.hash,
      pluginRoot,
      source: diagram.source,
    });
    rendered.set(diagram.hash, result.bytes);
    if (requestedGeneration === generation) {
      rendering = false;
      showCurrent();
    }
  } catch (error) {
    if (requestedGeneration === generation) {
      rendering = false;
      lastError = String(error.message || error);
      showCurrent();
    }
  }
}

function addRecord(record) {
  if (seenRecordIds.has(record.id)) return;
  seenRecordIds.add(record.id);

  let added = false;
  for (const diagram of extractMermaidBlocks(record.text)) {
    if (seenDiagramHashes.has(diagram.hash)) continue;
    seenDiagramHashes.add(diagram.hash);
    diagrams.push(diagram);
    currentIndex = diagrams.length - 1;
    added = true;
  }
  if (added) void renderCurrent();
}

async function adoptSession(info) {
  const agent = info.agent;
  const sessionId = info.agent_session_id || info.agent_session?.value;
  if (!agent || !sessionId) {
    throw new Error("Herdr has not received this pane's native agent session identity yet");
  }
  if (agent !== "codex" && agent !== "claude") {
    throw new Error(`Mermaid Preview supports Codex and Claude Code, not ${agent}`);
  }

  const key = `${agent}:${sessionId}`;
  if (key === currentSessionKey) return;
  const transcript = await resolveTranscript({
    agent,
    sessionId,
    sessionPath: info.agent_session_path,
  });
  if (!transcript) throw new Error(`Waiting for the ${agent} session transcript to appear`);

  follower?.close();
  currentSessionKey = key;
  sessionLabel = `${agent} · ${transcriptLabel(transcript)}`;
  diagrams = [];
  currentIndex = -1;
  rendered = new Map();
  seenDiagramHashes = new Set();
  seenRecordIds = new Set();
  views = new Map();
  lastError = null;
  showCurrent();

  follower = new JsonlFollower(transcript, agent);
  follower.on("record", addRecord);
  follower.on("error", (error) => {
    lastError = String(error.message || error);
    showCurrent();
  });
  await follower.start();
}

async function refreshSession() {
  try {
    await adoptSession(await paneInfo(sourcePaneId));
  } catch (error) {
    lastError = String(error.message || error);
    showCurrent();
  }
}

function selectRelative(delta) {
  if (diagrams.length === 0) return;
  currentIndex = (currentIndex + delta + diagrams.length) % diagrams.length;
  lastError = null;
  void renderCurrent();
}

function updateView(transform) {
  const diagram = diagrams[currentIndex];
  if (!diagram) return;
  views.set(diagram.hash, transform(currentView()));
  showCurrent();
}

function zoomBy(factor) {
  updateView((view) => ({
    ...view,
    zoom: Math.min(MAX_ZOOM, Math.max(1, view.zoom * factor)),
  }));
}

function panBy(deltaX, deltaY) {
  updateView((view) => ({
    ...view,
    panX: Math.min(1, Math.max(0, view.panX + deltaX)),
    panY: Math.min(1, Math.max(0, view.panY + deltaY)),
  }));
}

function resetView() {
  updateView(() => ({ ...DEFAULT_VIEW }));
}

async function cleanup(exitCode = 0) {
  if (closed) return;
  closed = true;
  follower?.close();
  clearInterval(sessionTimer);
  process.stdout.write(`${deleteAllKittyImages()}\u001b[?25h\u001b[0m`);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    if (state.pid === process.pid) await unlink(statePath);
  } catch {
    // The action treats missing or stale state files as closed previews.
  }
  await rm(cacheDirectory, { recursive: true, force: true });
  process.exit(exitCode);
}

process.stdout.write("\u001b]0;Mermaid preview\u0007\u001b[?25l");
showCurrent();
await refreshSession();
const sessionTimer = setInterval(() => void refreshSession(), 2_000);

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (data) => {
    const key = data.toString("utf8");
    if (key === "q" || key === "\u0003") void cleanup(0);
    else if (key === "+" || key === "=") zoomBy(ZOOM_FACTOR);
    else if (key === "-" || key === "_") zoomBy(1 / ZOOM_FACTOR);
    else if (key === "0") resetView();
    else if (key === "h" || key === "\u001b[D") panBy(-PAN_STEP, 0);
    else if (key === "l" || key === "\u001b[C") panBy(PAN_STEP, 0);
    else if (key === "k" || key === "\u001b[A") panBy(0, -PAN_STEP);
    else if (key === "j" || key === "\u001b[B") panBy(0, PAN_STEP);
    else if (key === "n" || key === "]") selectRelative(1);
    else if (key === "p" || key === "[") selectRelative(-1);
    else if (key === "r") void renderCurrent({ force: true });
  });
}

process.stdout.on("resize", showCurrent);
process.on("SIGINT", () => void cleanup(0));
process.on("SIGTERM", () => void cleanup(0));
process.on("SIGHUP", () => void cleanup(0));
process.on("uncaughtException", (error) => {
  lastError = String(error.stack || error);
  showCurrent();
});
process.on("unhandledRejection", (error) => {
  lastError = String(error?.stack || error);
  showCurrent();
});
