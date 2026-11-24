#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const launcher = join(import.meta.dirname, "..", "src", "open-preview.mjs");
const result = spawnSync(process.execPath, [launcher, ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
