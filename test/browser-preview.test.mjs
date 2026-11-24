import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBrowserPreviewServer } from "../src/browser-preview.mjs";
import { resolveSource } from "../src/sources/index.mjs";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("serves token-gated offline HTML, live state, and rendered PNG items for Herdr Browser", async (context) => {
  const dir = await mkdtemp(join(tmpdir(), "herdr-browser-preview-test-"));
  context.after(() => rm(dir, { recursive: true, force: true }));

  const transcriptPath = join(dir, "session-live.jsonl");
  await writeFile(transcriptPath, "", "utf8");

  const server = await createBrowserPreviewServer({
    cacheDirectory: join(dir, "cache"),
    inspectSession: async () => ({
      agent: "claude",
      sessionId: "session-live",
      sessionPath: transcriptPath,
    }),
    pluginRoot: join(import.meta.dirname, ".."),
    pollIntervalMs: 0,
    source: resolveSource("images"),
    sourceName: "images",
    targetId: "t1",
  });
  context.after(() => server.close());

  const wrongToken = await fetch(`http://127.0.0.1:${server.port}/wrong-token/`);
  assert.equal(wrongToken.status, 404);

  const pageResponse = await fetch(server.url);
  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.headers.get("content-security-policy") || "", /default-src 'none'/u);
  const html = await pageResponse.text();
  assert.match(html, /EventSource/u);

  const crossOrigin = await fetch(`${server.url}state`, {
    headers: { origin: "https://evil.example" },
  });
  assert.equal(crossOrigin.status, 403);

  await appendFile(
    transcriptPath,
    `${JSON.stringify({
      message: {
        content: [
          {
            source: {
              data: ONE_PIXEL_PNG.toString("base64"),
              media_type: "image/png",
              type: "base64",
            },
            type: "image",
          },
        ],
        role: "user",
      },
      type: "user",
      uuid: "img-1",
    })}\n`,
  );

  let state;
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${server.url}state`);
    state = await response.json();
    if (state.items.length === 1 && state.items[0].ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].ready, true);

  const imageResponse = await fetch(`${server.url}item/${state.items[0].hash}.png`);
  assert.equal(imageResponse.status, 200);
  assert.equal(imageResponse.headers.get("content-type"), "image/png");
  const bytes = Buffer.from(await imageResponse.arrayBuffer());
  assert.ok(bytes.equals(ONE_PIXEL_PNG));
});
