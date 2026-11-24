import assert from "node:assert/strict";
import test from "node:test";
import { parseLauncherArgs } from "../src/open-preview.mjs";
import {
  appBinary,
  cellAspectRatio,
  detectRuntime,
  resolveTuiContext,
} from "../src/runtime.mjs";

test("detects Herdr TUI, Herdr App, and Herdr Browser runtimes from environment", () => {
  const noneAlive = () => false;
  assert.equal(detectRuntime({ env: { HERDR_PLUGIN_STATE_DIR: "/tmp/state" }, probeDesktop: noneAlive }), "tui");
  assert.equal(detectRuntime({ env: { HERDR_ENV: "1" }, probeDesktop: noneAlive }), "tui");
  assert.equal(
    detectRuntime({ env: { HC_TERMINAL_ID: "t5", HERDR_BROWSER: "1" }, probeDesktop: noneAlive }),
    "browser",
  );
  assert.equal(
    detectRuntime({
      env: { HC_TERMINAL_ID: "t5", HERDR_APP_HOME: "/Users/test/.config/herdr-app-browser" },
      probeDesktop: noneAlive,
    }),
    "browser",
  );
  assert.equal(
    detectRuntime({
      env: { HC_TERMINAL_ID: "t5" },
      probeDesktop: (rt) => rt === "browser",
    }),
    "browser",
  );
  assert.equal(
    detectRuntime({
      env: { HC_TERMINAL_ID: "t5" },
      probeDesktop: (rt) => rt === "app",
    }),
    "app",
  );
  assert.equal(detectRuntime({ env: {}, explicit: "app" }), "app");
  assert.equal(detectRuntime({ env: {}, explicit: "browser" }), "browser");
  assert.throws(() => detectRuntime({ explicit: "unknown" }), /Unknown runtime/u);
});

test("chooses the matching desktop CLI binary for app and browser runtimes", () => {
  assert.equal(appBinary("app", {}), "herdr-app");
  assert.equal(appBinary("browser", {}), "herdr-browser");
  assert.equal(appBinary("app", { HERDR_APP_BIN: "/custom/herdr-app" }), "/custom/herdr-app");
});

test("uses Herdr TUI cell dimensions when provided and falls back to 0.5", () => {
  assert.equal(cellAspectRatio({}), 0.5);
  assert.equal(cellAspectRatio({ HERDR_CELL_HEIGHT_PX: "20", HERDR_CELL_WIDTH_PX: "10" }), 0.5);
  assert.equal(cellAspectRatio({ HERDR_CELL_HEIGHT_PX: "25", HERDR_CELL_WIDTH_PX: "15" }), 0.6);
  assert.equal(cellAspectRatio({ HERDR_CELL_HEIGHT_PX: "0", HERDR_CELL_WIDTH_PX: "10" }), 0.5);
});

test("reads focused_pane_id and workspace_id from Herdr TUI HERDR_PLUGIN_CONTEXT_JSON", () => {
  const ctx = resolveTuiContext({
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
      focused_pane_id: "w2:p9",
      workspace_id: "w2",
    }),
  });
  assert.deepEqual(ctx, { paneId: "w2:p9", workspaceId: "w2" });
});

test("parses launcher CLI options across TUI, App, and Browser invocations", () => {
  assert.deepEqual(parseLauncherArgs([]), {
    browser: false,
    help: false,
    place: "tab",
    runtime: "auto",
    sourceName: "mermaid",
    target: null,
  });

  assert.deepEqual(
    parseLauncherArgs(["images", "--target", "t1r5", "--place", "right", "--runtime", "browser", "--browser"]),
    {
      browser: true,
      help: false,
      place: "right",
      runtime: "browser",
      sourceName: "images",
      target: "t1r5",
    },
  );

  assert.throws(() => parseLauncherArgs(["--place", "left"]), /Invalid --place/u);
  assert.throws(() => parseLauncherArgs(["--bogus"]), /Unknown option/u);
});
