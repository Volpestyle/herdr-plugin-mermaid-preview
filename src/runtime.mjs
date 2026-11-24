import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { hcTerminalInfo, resolveHcSession } from "./hc.mjs";
import { herdrBinary, paneInfo } from "./herdr.mjs";
import { sessionIdentity } from "./session.mjs";

const execFileAsync = promisify(execFile);

export const RUNTIMES = new Set(["tui", "app", "browser"]);

function socketExists(homeDir) {
  return Boolean(homeDir && existsSync(join(homeDir, "herdr-app.sock")));
}

function defaultDesktopProbe(runtime, env = process.env) {
  const homeDir =
    runtime === "browser"
      ? join(homedir(), ".config", "herdr-app-browser")
      : env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app");
  if (!socketExists(homeDir)) return false;

  const result = spawnSync(appBinary(runtime, env), ["status"], {
    stdio: "ignore",
    timeout: 1_500,
  });
  return result.status === 0;
}

export function detectRuntime({
  env = process.env,
  explicit = null,
  probeDesktop = defaultDesktopProbe,
} = {}) {
  if (explicit && explicit !== "auto") {
    if (!RUNTIMES.has(explicit)) {
      throw new Error(`Unknown runtime: ${explicit}. Expected one of auto, tui, app, browser`);
    }
    return explicit;
  }

  if (env.HERDR_PREVIEW_RUNTIME && RUNTIMES.has(env.HERDR_PREVIEW_RUNTIME)) {
    return env.HERDR_PREVIEW_RUNTIME;
  }

  // Inside a Herdr TUI plugin action, plugin pane, or TUI shell.
  if (env.HERDR_PLUGIN_STATE_DIR || env.HERDR_ENV === "1" || (env.HERDR_PANE_ID && !env.HC_TERMINAL_ID)) {
    return "tui";
  }

  // Inside Herdr Browser (James's native browser fork) or pointed at its home.
  if (env.HERDR_BROWSER === "1" || env.HERDR_BROWSER === "true") {
    return "browser";
  }
  if (env.HERDR_APP_HOME) {
    return basename(env.HERDR_APP_HOME).includes("browser") ? "browser" : "app";
  }

  // Probe live desktop windows (a stale herdr-app.sock on disk must not shadow a live window).
  const browserAlive = probeDesktop("browser", env);
  const appAlive = probeDesktop("app", env);
  if (browserAlive && !appAlive) return "browser";
  if (appAlive && !browserAlive) return "app";
  if (browserAlive && appAlive) return "browser";
  if (env.HC_TERMINAL_ID) return "app";
  return "tui";
}

export function appBinary(runtime, env = process.env) {
  if (env.HERDR_APP_BIN) return env.HERDR_APP_BIN;
  return runtime === "browser" ? "herdr-browser" : "herdr-app";
}

export function defaultStateDirectory(runtime, env = process.env) {
  if (env.HERDR_PLUGIN_STATE_DIR) return env.HERDR_PLUGIN_STATE_DIR;
  if (env.XDG_STATE_HOME) return join(env.XDG_STATE_HOME, "herdr-preview");
  return join(homedir(), ".local", "state", "herdr-preview", runtime);
}

export function cellAspectRatio(env = process.env) {
  const width = Number.parseFloat(env.HERDR_CELL_WIDTH_PX || "");
  const height = Number.parseFloat(env.HERDR_CELL_HEIGHT_PX || "");
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    const ratio = width / height;
    if (ratio >= 0.25 && ratio <= 1.25) return ratio;
  }
  return 0.5;
}

export function runAppJsonSync(runtime, args, env = process.env) {
  const result = spawnSync(appBinary(runtime, env), args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const details = (result.stderr || result.stdout || "").trim();
    throw new Error(details || `${appBinary(runtime, env)} ${args.join(" ")} failed`);
  }
  return JSON.parse(result.stdout);
}

export async function runAppJson(runtime, args, env = process.env) {
  const { stdout } = await execFileAsync(appBinary(runtime, env), args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

export function resolveAppWindowTarget(runtime, explicitTarget = null, env = process.env) {
  let listing;
  let status = null;
  try {
    listing = runAppJsonSync(runtime, ["ls"], env);
  } catch {
    listing = null;
  }
  try {
    status = runAppJsonSync(runtime, ["status"], env);
  } catch {
    status = null;
  }

  const allTerminals = [];
  for (const space of listing?.spaces || []) {
    for (const tab of space.tabs || []) {
      for (const entry of tab.terminals || []) {
        allTerminals.push({
          app: entry.app || null,
          paneId: entry.pane || null,
          spaceId: space.id,
          tabId: tab.id,
          terminalId: entry.terminal,
        });
        for (const sub of entry.sub_agents || []) {
          allTerminals.push({
            app: sub.app || null,
            paneId: entry.pane || null,
            spaceId: space.id,
            tabId: tab.id,
            terminalId: sub.terminal,
          });
        }
      }
    }
  }

  const targetId = explicitTarget || env.HERDR_PREVIEW_SOURCE_TERMINAL || null;
  if (targetId) {
    const matched = allTerminals.find(
      (entry) => entry.terminalId === targetId || entry.paneId === targetId,
    );
    if (matched) return matched;
    return {
      app: null,
      paneId: null,
      spaceId: status?.space || null,
      tabId: status?.tab || null,
      terminalId: targetId,
    };
  }

  if (status?.focused_pane) {
    const focused = allTerminals.find((entry) => entry.paneId === status.focused_pane);
    if (focused) return focused;
  }

  if (env.HC_TERMINAL_ID) {
    const self = allTerminals.find((entry) => entry.terminalId === env.HC_TERMINAL_ID);
    if (self) return self;
    return {
      app: null,
      paneId: null,
      spaceId: status?.space || null,
      tabId: status?.tab || null,
      terminalId: env.HC_TERMINAL_ID,
    };
  }

  if (status?.agent) {
    const agent = allTerminals.find((entry) => entry.terminalId === status.agent);
    if (agent) return agent;
  }

  const activeSupported = allTerminals.find(
    (entry) => entry.app === "claude-code" || entry.app === "claude" || entry.app === "codex",
  );
  return activeSupported || allTerminals[0] || null;
}

export function resolveTuiContext(env = process.env) {
  let context = {};
  try {
    context = JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
  } catch {
    context = {};
  }

  let paneId =
    env.HERDR_PANE_ID ||
    env.HERDR_ACTIVE_PANE_ID ||
    context.focused_pane_id ||
    context.pane?.pane_id ||
    context.focused_pane?.pane_id ||
    null;

  if (!paneId) {
    try {
      const result = spawnSync(herdrBinary(), ["pane", "list"], { encoding: "utf8" });
      if (result.status === 0) {
        const response = JSON.parse(result.stdout);
        paneId = response.result?.panes?.find((pane) => pane.focused)?.pane_id || null;
      }
    } catch {
      paneId = null;
    }
  }

  const workspaceId =
    env.HERDR_WORKSPACE_ID ||
    context.workspace_id ||
    (paneId ? paneId.split(":", 1)[0] : null);

  return { paneId, workspaceId };
}

export async function inspectSourceSession({ runtime, targetId }) {
  if (runtime === "tui") {
    const pane = await paneInfo(targetId);
    return sessionIdentity(pane);
  }

  if (targetId.includes("/")) {
    throw new Error(
      `Remote terminal ${targetId} transcripts live on that machine and cannot be read locally`,
    );
  }

  const info = await hcTerminalInfo(targetId);
  return resolveHcSession(info);
}
