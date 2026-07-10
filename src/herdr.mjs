import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function herdrBinary() {
  return process.env.HERDR_BIN_PATH || "herdr";
}

export async function runHerdrJson(args) {
  const { stdout } = await execFileAsync(herdrBinary(), args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

export async function paneInfo(paneId) {
  const response = await runHerdrJson(["pane", "get", paneId]);
  const pane = response?.result?.pane;
  if (!pane) throw new Error(`Herdr did not return pane information for ${paneId}`);
  return pane;
}
