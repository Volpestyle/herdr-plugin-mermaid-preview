import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderImage } from "../src/render/image.mjs";
import { extractImages } from "../src/sources/images.mjs";
import { encodeKittyPng, pngDimensions } from "../src/kitty.mjs";

/** A real 1x1 PNG, so the Kitty encoder sees something it can parse. */
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("passes PNG through untouched", async () => {
  const [item] = extractImages({ kind: "image", id: "a:0", data: ONE_PIXEL_PNG.toString("base64") });
  const result = await renderImage({ cacheDirectory: "/unused", item });

  assert.ok(result.bytes.equals(ONE_PIXEL_PNG), "PNG should not be re-encoded");
  assert.deepEqual(pngDimensions(result.bytes), { width: 1, height: 1 });
});

test("refuses an item with no data", async () => {
  await assert.rejects(
    renderImage({ cacheDirectory: "/unused", item: { format: "png", bytes: Buffer.alloc(0) } }),
    /carried no data/u,
  );
});

test("converts a non-PNG through a system converter", async (t) => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "herdr-image-render-"));
  t.after(() => rm(cacheDirectory, { recursive: true, force: true }));

  // A JPEG built by whatever converter this machine has, so the test exercises
  // the real conversion path rather than a fixture.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const { writeFile, readFile } = await import("node:fs/promises");

  const pngPath = join(cacheDirectory, "seed.png");
  const jpegPath = join(cacheDirectory, "seed.jpg");
  await writeFile(pngPath, ONE_PIXEL_PNG);
  try {
    await execFileAsync("sips", ["-s", "format", "jpeg", pngPath, "--out", jpegPath]);
  } catch {
    try {
      await execFileAsync("magick", [pngPath, jpegPath]);
    } catch {
      t.skip("no system image converter available");
      return;
    }
  }

  const jpeg = await readFile(jpegPath);
  const [item] = extractImages({ kind: "image", id: "b:0", data: jpeg.toString("base64") });
  assert.equal(item.format, "jpeg");

  const result = await renderImage({ cacheDirectory, item });
  assert.deepEqual(pngDimensions(result.bytes), { width: 1, height: 1 });
  // The converted bytes must survive the encoder the preview pane uses.
  assert.match(
    encodeKittyPng(result.bytes, { columns: 1, rows: 1, imageId: 1 }),
    /_Ga=T,f=100/u,
  );
});
