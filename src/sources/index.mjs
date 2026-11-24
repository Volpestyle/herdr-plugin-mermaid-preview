import { extractImages } from "./images.mjs";
import { extractMermaidBlocks } from "./mermaid.mjs";
import { renderImage } from "../render/image.mjs";
import { renderMermaid } from "../render/mermaid.mjs";

/**
 * What a preview pane can show.
 *
 * The pane itself only knows about items with a hash that render to PNG bytes;
 * everything specific to a kind of content lives behind one of these. Adding a
 * third — PDFs, charts — means adding an entry here and an action in
 * herdr-plugin.toml, not touching the viewport or the Kitty encoder.
 */
export const SOURCES = {
  mermaid: {
    label: "Mermaid",
    waitingFor: "a complete Mermaid fence",
    extract: (record) => (record.kind === "text" ? extractMermaidBlocks(record.text) : []),
    render: (item, { cacheDirectory, pluginRoot }) =>
      renderMermaid({ cacheDirectory, hash: item.hash, pluginRoot, source: item.source }),
  },
  images: {
    label: "Image",
    waitingFor: "an image",
    extract: (record) => extractImages(record),
    render: (item, { cacheDirectory }) => renderImage({ cacheDirectory, item }),
  },
};

export function resolveSource(name) {
  const source = SOURCES[name];
  if (!source) {
    throw new Error(`Unknown preview source: ${name}. Expected one of ${Object.keys(SOURCES).join(", ")}`);
  }
  return source;
}
