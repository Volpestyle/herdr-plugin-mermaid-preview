import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Getting transcript images onto a Kitty-graphics terminal.
 *
 * The protocol takes PNG directly, so the common case is not a render at all —
 * the bytes go straight through, and the viewport crop is expressed as a source
 * rectangle against the original. Only the other formats need converting, and
 * they get there through whatever the machine already has: `sips` ships with
 * macOS, ImageMagick or ffmpeg cover Linux. Nothing is added to package.json
 * for this, and no image data is handed to a browser.
 */

const CONVERTERS = [
  { command: "sips", args: (input, output) => ["-s", "format", "png", input, "--out", output] },
  { command: "magick", args: (input, output) => [input, `png:${output}`] },
  { command: "convert", args: (input, output) => [input, `png:${output}`] },
  {
    command: "ffmpeg",
    args: (input, output) => ["-loglevel", "error", "-y", "-i", input, "-frames:v", "1", output],
  },
];

let cachedConverter;

async function available(command) {
  const pathEnv = process.env.PATH || "";
  for (const directory of pathEnv.split(delimiter)) {
    if (!directory) continue;
    try {
      await access(join(directory, command), fsConstants.X_OK);
      return true;
    } catch {
      // Keep searching PATH.
    }
  }
  return false;
}

async function findConverter() {
  if (cachedConverter !== undefined) return cachedConverter;
  for (const converter of CONVERTERS) {
    if (await available(converter.command)) {
      cachedConverter = converter;
      return converter;
    }
  }
  cachedConverter = null;
  return null;
}

/** Exposed so tests can exercise both branches without a real converter. */
export function resetConverterCache() {
  cachedConverter = undefined;
}

export async function renderImage({ cacheDirectory, item }) {
  if (!item?.bytes?.length) throw new Error("Image record carried no data");
  if (item.format === "png") return { bytes: item.bytes };

  const converter = await findConverter();
  if (!converter) {
    throw new Error(
      `Cannot display ${item.format}: install ImageMagick or ffmpeg to convert it to PNG`,
    );
  }

  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  const inputPath = join(cacheDirectory, `${item.hash}.${item.format}`);
  const outputPath = join(cacheDirectory, `${item.hash}.png`);

  try {
    await writeFile(inputPath, item.bytes, { mode: 0o600 });
    await execFileAsync(converter.command, converter.args(inputPath, outputPath), {
      maxBuffer: 4 * 1024 * 1024,
    });
    return { bytes: await readFile(outputPath) };
  } catch (error) {
    const details = String(error.stderr || error.message || error).trim();
    throw new Error(`${converter.command} could not convert this ${item.format}: ${details.slice(-500)}`);
  } finally {
    await rm(inputPath, { force: true });
  }
}
