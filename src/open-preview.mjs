import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { herdrBinary } from "./herdr.mjs";

function contextPaneId() {
  if (process.env.HERDR_PANE_ID) return process.env.HERDR_PANE_ID;
  if (process.env.HERDR_ACTIVE_PANE_ID) return process.env.HERDR_ACTIVE_PANE_ID;
  try {
    const context = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
    return context.pane?.pane_id || context.focused_pane?.pane_id || null;
  } catch {
    // Fall through to the live focused pane for CLI-triggered actions, whose
    // invocation context intentionally contains no UI selection.
  }

  try {
    const result = spawnSync(herdrBinary(), ["pane", "list"], {
      encoding: "utf8",
    });
    if (result.status !== 0) return null;
    const response = JSON.parse(result.stdout);
    return response.result?.panes?.find((pane) => pane.focused)?.pane_id || null;
  } catch {
    return null;
  }
}

function statePath(stateDirectory, sourcePaneId) {
  const key = createHash("sha256").update(sourcePaneId).digest("hex").slice(0, 16);
  return join(stateDirectory, `preview-${key}.json`);
}

function focusExistingPreview(path) {
  try {
    const state = JSON.parse(readFileSync(path, "utf8"));
    process.kill(state.pid, 0);
    const result = spawnSync(
      herdrBinary(),
      ["plugin", "pane", "focus", state.previewPaneId],
      { stdio: "ignore" },
    );
    return result.status === 0;
  } catch {
    return false;
  }
}

const sourcePaneId = contextPaneId();
if (!sourcePaneId) {
  console.error("Mermaid Preview needs a pane context");
  process.exit(2);
}
const workspaceId = process.env.HERDR_WORKSPACE_ID || sourcePaneId.split(":", 1)[0];

const stateDirectory = process.env.HERDR_PLUGIN_STATE_DIR;
if (!stateDirectory) {
  console.error("Herdr did not provide HERDR_PLUGIN_STATE_DIR");
  process.exit(2);
}

if (focusExistingPreview(statePath(stateDirectory, sourcePaneId))) process.exit(0);

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
    `MERMAID_SOURCE_PANE_ID=${sourcePaneId}`,
    "--focus",
  ],
  { stdio: "inherit" },
);

process.exit(result.status ?? 1);
