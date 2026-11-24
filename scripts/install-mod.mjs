import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const pluginRoot = resolve(import.meta.dirname, "..");
const sourceDir = join(pluginRoot, "mods", "herdr-preview");

function resolveTargetDirs(argv) {
  const target = argv[0] || "app";
  if (target === "app") {
    return [join(process.env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app"), "mods", "herdr-preview")];
  }
  if (target === "browser") {
    return [join(homedir(), ".config", "herdr-app-browser", "mods", "herdr-preview")];
  }
  if (target === "all") {
    return [
      join(homedir(), ".config", "herdr-app", "mods", "herdr-preview"),
      join(homedir(), ".config", "herdr-app-browser", "mods", "herdr-preview"),
    ];
  }
  if (target.startsWith("/") || target.startsWith("~")) {
    const expanded = target.startsWith("~/") ? join(homedir(), target.slice(2)) : target;
    return [join(expanded, "mods", "herdr-preview")];
  }
  throw new Error(`Unknown install target: ${target}. Expected app, browser, all, or an app home path`);
}

const destinations = resolveTargetDirs(process.argv.slice(2));

for (const destination of destinations) {
  await mkdir(destination, { recursive: true });
  await copyFile(join(sourceDir, "main.js"), join(destination, "main.js"));
  await copyFile(join(sourceDir, "mod.json"), join(destination, "mod.json"));
  await writeFile(
    join(destination, "config.json"),
    `${JSON.stringify({ node: process.execPath, pluginRoot }, null, 2)}\n`,
    "utf8",
  );
  console.log(`Installed Herdr Preview mod to ${destination}`);
}
