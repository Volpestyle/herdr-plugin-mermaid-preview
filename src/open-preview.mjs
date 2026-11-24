import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { herdrBinary } from "./herdr.mjs";
import {
  appBinary,
  defaultStateDirectory,
  detectRuntime,
  resolveAppWindowTarget,
  resolveTuiContext,
} from "./runtime.mjs";
import { resolveSource } from "./sources/index.mjs";

export function parseLauncherArgs(argv) {
  const options = {
    browser: false,
    help: false,
    place: "tab",
    runtime: "auto",
    sourceName: "mermaid",
    target: null,
  };
  let positionalSet = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "--browser") {
      options.browser = true;
    } else if (arg === "--runtime" && argv[i + 1]) {
      options.runtime = argv[++i];
    } else if (arg === "--place" && argv[i + 1]) {
      options.place = argv[++i];
    } else if ((arg === "--target" || arg === "--terminal" || arg === "--pane") && argv[i + 1]) {
      options.target = argv[++i];
    } else if (arg === "--source" && argv[i + 1]) {
      options.sourceName = argv[++i];
      positionalSet = true;
    } else if (!arg.startsWith("-") && !positionalSet) {
      options.sourceName = arg;
      positionalSet = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!["tab", "right", "down"].includes(options.place)) {
    throw new Error(`Invalid --place: ${options.place}. Expected tab, right, or down`);
  }

  return options;
}

function statePath(stateDirectory, runtime, targetId, sourceName, mode) {
  const key = createHash("sha256")
    .update(`${runtime}:${targetId}:${sourceName}:${mode}`)
    .digest("hex")
    .slice(0, 16);
  return join(stateDirectory, `preview-${key}.json`);
}

function legacyTuiStatePath(stateDirectory, sourcePaneId, sourceName) {
  const key = createHash("sha256")
    .update(`${sourcePaneId}:${sourceName}`)
    .digest("hex")
    .slice(0, 16);
  return join(stateDirectory, `preview-${key}.json`);
}

function readLiveState(path) {
  try {
    const state = JSON.parse(readFileSync(path, "utf8"));
    process.kill(state.pid, 0);
    return state;
  } catch {
    return null;
  }
}

function focusExistingTuiPreview(stateDirectory, sourcePaneId, sourceName) {
  const state =
    readLiveState(statePath(stateDirectory, "tui", sourcePaneId, sourceName, "terminal")) ||
    readLiveState(legacyTuiStatePath(stateDirectory, sourcePaneId, sourceName));
  if (!state?.previewPaneId) return false;

  const result = spawnSync(herdrBinary(), ["plugin", "pane", "focus", state.previewPaneId], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function focusExistingAppPreview(runtime, stateDirectory, targetId, sourceName, mode) {
  const state = readLiveState(statePath(stateDirectory, runtime, targetId, sourceName, mode));
  if (!state) return false;

  const focusArgs =
    mode === "browser" && state.previewPaneId
      ? { pane: state.previewPaneId }
      : state.previewTerminalId
        ? { terminal: state.previewTerminalId }
        : state.previewPaneId
          ? { pane: state.previewPaneId }
          : null;
  if (!focusArgs) return false;

  const result = spawnSync(
    appBinary(runtime),
    ["do", "pane.focus", JSON.stringify(focusArgs)],
    { stdio: "ignore" },
  );
  return result.status === 0;
}

function printHelp() {
  console.log(`Usage: herdr-preview [mermaid|images] [options]

Options:
  --target <id>           Herdr TUI pane id or herdr-core terminal id (default: focused)
  --place <tab|right|down> Where to open the preview in Herdr App / Browser (default: tab)
  --runtime <auto|tui|app|browser>
                          Target Herdr runtime (default: auto-detect)
  --browser               Open in a native Herdr Browser pane (Herdr Browser only)
  -h, --help              Show this help`);
}

function openTuiPreview({ sourceName, target }) {
  const context = resolveTuiContext();
  const sourcePaneId = target || context.paneId;
  if (!sourcePaneId) {
    console.error("Preview needs a pane context");
    process.exit(2);
  }
  const workspaceId = context.workspaceId || sourcePaneId.split(":", 1)[0];
  const stateDirectory = process.env.HERDR_PLUGIN_STATE_DIR;
  if (!stateDirectory) {
    console.error("Herdr did not provide HERDR_PLUGIN_STATE_DIR");
    process.exit(2);
  }

  if (focusExistingTuiPreview(stateDirectory, sourcePaneId, sourceName)) process.exit(0);

  const pluginId = process.env.HERDR_PLUGIN_ID || "dev.volpestyle.mermaid-preview";
  const result = spawnSync(
    herdrBinary(),
    [
      "plugin",
      "pane",
      "open",
      "--plugin",
      pluginId,
      "--entrypoint",
      "preview",
      "--placement",
      "tab",
      "--workspace",
      workspaceId,
      "--env",
      `HERDR_PREVIEW_SOURCE_PANE_ID=${sourcePaneId}`,
      "--env",
      `HERDR_PREVIEW_SOURCE=${sourceName}`,
      "--env",
      "HERDR_PREVIEW_RUNTIME=tui",
      "--focus",
    ],
    { stdio: "inherit" },
  );
  process.exit(result.status ?? 1);
}

function openDesktopPreview({ browser, place, runtime, source, sourceName, target }) {
  if (browser && runtime !== "browser") {
    console.error("--browser requires Herdr Browser (herdr-browser)");
    process.exit(2);
  }

  const resolved = resolveAppWindowTarget(runtime, target);
  if (!resolved?.terminalId) {
    console.error(`Preview could not find a target terminal in ${appBinary(runtime)}`);
    process.exit(2);
  }

  const stateDirectory = defaultStateDirectory(runtime);
  const mode = browser ? "browser" : "terminal";
  if (focusExistingAppPreview(runtime, stateDirectory, resolved.terminalId, sourceName, mode)) {
    process.exit(0);
  }

  if (browser) {
    const serverScript = join(import.meta.dirname, "browser-preview.mjs");
    const args = [
      serverScript,
      "--runtime",
      runtime,
      "--source",
      sourceName,
      "--target",
      resolved.terminalId,
      "--place",
      place,
      "--state-dir",
      stateDirectory,
    ];
    if (resolved.spaceId) args.push("--space", resolved.spaceId);
    if (resolved.paneId) args.push("--pane", resolved.paneId);

    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    process.exit(0);
  }

  const previewScript = join(import.meta.dirname, "preview.mjs");
  const previewArgv = [
    process.execPath,
    previewScript,
    "--runtime",
    runtime,
    "--source",
    sourceName,
    "--target",
    resolved.terminalId,
    "--state-dir",
    stateDirectory,
  ];

  let commandName = "tab.new";
  let payload = {
    argv: previewArgv,
    focus: true,
    name: `${source.label} preview`,
  };
  if (resolved.spaceId) payload.space = resolved.spaceId;

  if (place === "right" || place === "down") {
    commandName = "pane.split";
    payload = {
      argv: previewArgv,
      direction: place,
    };
    if (resolved.paneId) payload.pane = resolved.paneId;
  }

  const result = spawnSync(
    appBinary(runtime),
    ["do", commandName, JSON.stringify(payload)],
    { stdio: "inherit" },
  );
  process.exit(result.status ?? 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let options;
  try {
    options = parseLauncherArgs(process.argv.slice(2));
  } catch (error) {
    console.error(String(error.message || error));
    process.exit(2);
  }

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  let source;
  let runtime;
  try {
    source = resolveSource(options.sourceName);
    runtime = detectRuntime({ explicit: options.runtime });
  } catch (error) {
    console.error(String(error.message || error));
    process.exit(2);
  }

  if (runtime === "tui") {
    openTuiPreview({ sourceName: options.sourceName, target: options.target });
  } else {
    openDesktopPreview({
      browser: options.browser,
      place: options.place,
      runtime,
      source,
      sourceName: options.sourceName,
      target: options.target,
    });
  }
}
