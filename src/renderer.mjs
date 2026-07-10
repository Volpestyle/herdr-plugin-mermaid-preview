import { renderMermaid as renderWithMermaidCli } from "@mermaid-js/mermaid-cli";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import puppeteer, { DEFAULT_INTERCEPT_RESOLUTION_PRIORITY } from "puppeteer";

const MAX_SOURCE_BYTES = 100_000;
const NETWORK_DENY_PRIORITY = DEFAULT_INTERCEPT_RESOLUTION_PRIORITY + 100;
const MERMAID_INTERCEPT_ORIGIN = "https://mermaid-cli-intercept.invalid";
const EXTERNAL_RESOURCE_PATTERNS = [
  /\b(?:https?|file|ftp|wss?):/iu,
  /(?:^|[\s"'(=])\/\//imu,
  /\bimg\s*:/iu,
  /<img\b/iu,
  /@import\b/iu,
  /\burl\s*\(/iu,
];

function renderWidth() {
  const requested = Number.parseInt(process.env.MERMAID_PREVIEW_WIDTH || "1600", 10);
  if (!Number.isFinite(requested)) return 1600;
  return Math.min(4096, Math.max(320, requested));
}

async function mermaidConfig(pluginRoot) {
  return JSON.parse(await readFile(join(pluginRoot, "config", "mermaid.json"), "utf8"));
}

export function installNetworkGuard(browser) {
  const createPage = browser.newPage.bind(browser);

  browser.newPage = async (...args) => {
    const page = await createPage(...args);
    let allowedInitialDocument = false;
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const requestUrl = request.url();

      // Mermaid CLI starts from one local HTML shell before installing its own
      // asset interceptor. Allow exactly that first top-level file navigation.
      if (
        !allowedInitialDocument &&
        requestUrl.startsWith("file:") &&
        request.isNavigationRequest() &&
        request.frame() === page.mainFrame()
      ) {
        allowedInitialDocument = true;
        request.continue(undefined, NETWORK_DENY_PRIORITY);
        return;
      }

      // Mermaid CLI resolves this reserved origin to allowlisted local package
      // assets. Leave it unresolved here so its stricter interceptor responds.
      if (requestUrl.startsWith(MERMAID_INTERCEPT_ORIGIN)) return;

      // Assistant-authored diagrams are untrusted. Deny HTTP(S), localhost,
      // private networks, file URLs, and any future fetch-capable scheme.
      request.abort("blockedbyclient", NETWORK_DENY_PRIORITY);
    });
    return page;
  };
}

export function assertOfflineSafe(source) {
  if (EXTERNAL_RESOURCE_PATTERNS.some((pattern) => pattern.test(source))) {
    throw new Error("Mermaid external resources are disabled in terminal previews");
  }
}

export async function renderMermaid({ cacheDirectory, hash, pluginRoot, source }) {
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
    throw new Error(`Mermaid source exceeds the ${MAX_SOURCE_BYTES}-byte safety limit`);
  }
  assertOfflineSafe(source);

  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  const outputPath = join(cacheDirectory, `${hash}.png`);
  const browser = await puppeteer.launch({ headless: true });
  installNetworkGuard(browser);

  try {
    const result = await renderWithMermaidCli(browser, source, "png", {
      backgroundColor: "transparent",
      mermaidConfig: {
        ...(await mermaidConfig(pluginRoot)),
        theme: process.env.MERMAID_PREVIEW_THEME || "dark",
      },
      viewport: {
        deviceScaleFactor: 2,
        height: 600,
        width: renderWidth(),
      },
    });
    const bytes = Buffer.from(result.data);
    await writeFile(outputPath, bytes, { mode: 0o600 });
    return { bytes, path: outputPath };
  } catch (error) {
    const details = String(error.message || error).trim();
    throw new Error(details.slice(-2_000));
  } finally {
    await browser.close();
  }
}
