import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteAllKittyImages,
  encodeKittyPng,
  pngDimensions,
  zoomedImagePlacement,
} from "./kitty.mjs";
import {
  cellAspectRatio,
  defaultStateDirectory,
  detectRuntime,
  inspectSourceSession,
} from "./runtime.mjs";
import { resolveSource } from "./sources/index.mjs";
import { JsonlFollower, resolveTranscript, transcriptLabel } from "./transcripts.mjs";

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--runtime" && argv[i + 1]) {
      options.runtime = argv[++i];
    } else if (arg === "--source" && argv[i + 1]) {
      options.source = argv[++i];
    } else if ((arg === "--target" || arg === "--terminal" || arg === "--pane") && argv[i + 1]) {
      options.target = argv[++i];
    } else if (arg === "--state-dir" && argv[i + 1]) {
      options.stateDir = argv[++i];
    }
  }
  return options;
}

const cli = parseArgs(process.argv.slice(2));
const runtime = detectRuntime({ explicit: cli.runtime || null });
const sourceName = cli.source || process.env.HERDR_PREVIEW_SOURCE || "mermaid";
const sourceTargetId =
  cli.target ||
  process.env.HERDR_PREVIEW_SOURCE_PANE_ID ||
  process.env.HERDR_PREVIEW_SOURCE_TERMINAL;
const previewPaneId = process.env.HERDR_PANE_ID || null;
const previewTerminalId = process.env.HC_TERMINAL_ID || null;
const pluginRoot = process.env.HERDR_PLUGIN_ROOT || join(import.meta.dirname, "..");
const stateDirectory = cli.stateDir || defaultStateDirectory(runtime);

if (!sourceTargetId || (runtime === "tui" && !previewPaneId)) {
  console.error("Preview is missing its Herdr pane or terminal target");
  process.exit(2);
}

let source;
try {
  source = resolveSource(sourceName);
} catch (error) {
  console.error(String(error.message || error));
  process.exit(2);
}

const cacheDirectory = await mkdtemp(join(tmpdir(), `herdr-${sourceName}-preview-`));
const stateKey = createHash("sha256")
  .update(`${runtime}:${sourceTargetId}:${sourceName}:terminal`)
  .digest("hex")
  .slice(0, 16);
const statePath = join(stateDirectory, `preview-${stateKey}.json`);

let closed = false;
let currentIndex = -1;
let currentSessionKey = null;
let items = [];
let follower = null;
let generation = 0;
let lastError = null;
let rendered = new Map();
let rendering = false;
let seenHashes = new Set();
let seenRecordIds = new Set();
let sessionLabel = "locating session";
let views = new Map();

const DEFAULT_VIEW = Object.freeze({ panX: 0.5, panY: 0.5, zoom: 1 });
const MAX_ITEMS = 100;
const MAX_RENDERED = 8;
const MAX_ZOOM = 16;
const PAN_STEP = 0.1;
const ZOOM_FACTOR = 1.25;

await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
await writeFile(
  statePath,
  JSON.stringify({
    mode: "terminal",
    pid: process.pid,
    previewPaneId,
    previewTerminalId,
    runtime,
    sourceName,
    sourcePaneId: sourceTargetId,
    sourceTargetId,
  }),
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
  const item = items[currentIndex];
  return item ? views.get(item.hash) || DEFAULT_VIEW : DEFAULT_VIEW;
}

/**
 * Keep the retained set bounded. A Mermaid session accumulates a handful of
 * small diagrams, but a session full of pasted screenshots is megabytes each —
 * without a ceiling the pane grows for as long as the agent does.
 */
function forget(count) {
  const dropped = items.splice(0, count);
  for (const item of dropped) {
    views.delete(item.hash);
    rendered.delete(item.hash);
  }
  currentIndex = Math.max(0, currentIndex - dropped.length);
}

function cacheRendered(hash, bytes) {
  rendered.set(hash, bytes);
  for (const key of [...rendered.keys()].slice(0, rendered.size - MAX_RENDERED)) {
    rendered.delete(key);
  }
}

function writeScreen({ error = null, image = null, message = null } = {}) {
  if (closed) return;
  const size = terminalSize();
  const item = items[currentIndex];
  const view = currentView();
  const indexLabel = item ? `${currentIndex + 1}/${items.length}` : "0/0";
  const header = truncate(
    ` ${source.label} ${indexLabel} · ${item?.type || sessionLabel} · zoom ${view.zoom.toFixed(1)}x · source ${sourceTargetId}`,
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
      cellAspectRatio(),
    );
    const imageId = Number.parseInt(item.hash.slice(0, 7), 16) || 1;
    output += encodeKittyPng(image, { ...placement, imageId });
  } else {
    const body = error ? `Render failed:\n${error}` : message || `Waiting for ${source.waitingFor}…`;
    output += truncate(body, size.columns * Math.max(1, size.rows - 3));
  }

  output += `\u001b[${size.rows};1H\u001b[2m${footer}\u001b[0m\u001b[?25l`;
  process.stdout.write(output);
}

function showCurrent() {
  const item = items[currentIndex];
  if (!item) {
    writeScreen({ message: lastError || `Watching ${sessionLabel} for ${source.waitingFor}…` });
    return;
  }
  const cached = rendered.get(item.hash);
  if (cached) writeScreen({ image: cached });
  else if (lastError) writeScreen({ error: lastError });
  else writeScreen({ message: rendering ? `Rendering ${source.label}…` : `Preparing ${source.label}…` });
}

async function renderCurrent({ force = false } = {}) {
  const item = items[currentIndex];
  if (!item) return;
  if (!force && rendered.has(item.hash)) {
    showCurrent();
    return;
  }

  const requestedGeneration = ++generation;
  rendering = true;
  lastError = null;
  showCurrent();

  try {
    const result = await source.render(item, { cacheDirectory, pluginRoot });
    cacheRendered(item.hash, result.bytes);
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
  for (const item of source.extract(record)) {
    if (seenHashes.has(item.hash)) continue;
    seenHashes.add(item.hash);
    items.push(item);
    added = true;
  }
  if (!added) return;
  if (items.length > MAX_ITEMS) forget(items.length - MAX_ITEMS);
  currentIndex = items.length - 1;
  void renderCurrent();
}

async function adoptSession({ agent, sessionId, sessionPath }) {
  if (!agent) {
    throw new Error(
      runtime === "tui"
        ? "Herdr has not received this pane's native agent session identity yet"
        : `No Claude Code or Codex agent detected in terminal ${sourceTargetId}`,
    );
  }
  if (agent !== "codex" && agent !== "claude") {
    throw new Error(`Preview supports Codex and Claude Code, not ${agent}`);
  }
  if (!sessionId) {
    throw new Error(
      runtime === "tui"
        ? "Herdr has not received this pane's native agent session identity yet"
        : `Waiting for a ${agent} session transcript in terminal ${sourceTargetId}`,
    );
  }

  const key = `${agent}:${sessionId}`;
  if (key === currentSessionKey) return;
  const transcript = await resolveTranscript({
    agent,
    sessionId,
    sessionPath,
  });
  if (!transcript) throw new Error(`Waiting for the ${agent} session transcript to appear`);

  follower?.close();
  currentSessionKey = key;
  sessionLabel = `${agent} · ${transcriptLabel(transcript)}`;
  items = [];
  currentIndex = -1;
  rendered = new Map();
  seenHashes = new Set();
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
    const identity = await inspectSourceSession({ runtime, targetId: sourceTargetId });
    await adoptSession(identity);
  } catch (error) {
    lastError = String(error.message || error);
    showCurrent();
  }
}

function selectRelative(delta) {
  if (items.length === 0) return;
  currentIndex = (currentIndex + delta + items.length) % items.length;
  lastError = null;
  void renderCurrent();
}

function updateView(transform) {
  const item = items[currentIndex];
  if (!item) return;
  views.set(item.hash, transform(currentView()));
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
    // The launcher treats missing or stale state files as closed previews.
  }
  await rm(cacheDirectory, { recursive: true, force: true });
  process.exit(exitCode);
}

process.stdout.write(`\u001b]0;${source.label} preview\u0007\u001b[?25l`);
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
