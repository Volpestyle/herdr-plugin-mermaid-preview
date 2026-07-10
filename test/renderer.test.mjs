import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer";
import test from "node:test";
import { installNetworkGuard, renderMermaid } from "../src/renderer.mjs";

test("rejects oversized Mermaid before creating renderer inputs", async () => {
  await assert.rejects(
    renderMermaid({
      cacheDirectory: "/unused",
      hash: "oversized",
      pluginRoot: "/unused",
      source: "x".repeat(100_001),
    }),
    /100000-byte safety limit/u,
  );
});

test("blocks outbound requests from assistant-authored image nodes", async (context) => {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(200, { "content-type": "image/png" });
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  assert.equal(typeof address, "object");
  const directory = await mkdtemp(join(tmpdir(), "mermaid-network-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));

  await assert.rejects(
    renderMermaid({
      cacheDirectory: directory,
      hash: "network-guard",
      pluginRoot: join(import.meta.dirname, ".."),
      source: [
        "flowchart LR",
        `  A@{ img: \"http://127.0.0.1:${address.port}/probe.png\", label: \"blocked\" }`,
        "  A --> B[Safe]",
      ].join("\n"),
    }),
    /external resources are disabled/u,
  );
  assert.equal(requestCount, 0);
});

test("Chromium network guard aborts requests that bypass source preflight", async (context) => {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.end("unexpected");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  assert.equal(typeof address, "object");
  const browser = await puppeteer.launch({
    headless: true,
    // GitHub-hosted Ubuntu runners disable Chromium's user-namespace sandbox.
    // This applies only to the test browser; production rendering stays sandboxed.
    ...(process.env.CI === "true" ? { args: ["--no-sandbox"] } : {}),
  });
  context.after(() => browser.close());
  installNetworkGuard(browser);
  const page = await browser.newPage();

  const fetched = await page.evaluate(async (requestUrl) => {
    try {
      await fetch(requestUrl);
      return true;
    } catch {
      return false;
    }
  }, `http://127.0.0.1:${address.port}/probe`);

  assert.equal(fetched, false);
  assert.equal(requestCount, 0);
});
