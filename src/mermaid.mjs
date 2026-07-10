import { createHash } from "node:crypto";

const OPENING_FENCE = /^(\s*)(`{3,}|~{3,})[\t ]*mermaid(?:[\t ].*)?$/i;

function stripCommonIndent(lines) {
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  if (nonEmpty.length === 0) return "";

  const indent = Math.min(
    ...nonEmpty.map((line) => line.match(/^[\t ]*/u)?.[0].length ?? 0),
  );
  return lines.map((line) => line.slice(Math.min(indent, line.length))).join("\n").trim();
}

export function diagramType(source) {
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("%%")) continue;
    return line.match(/^([A-Za-z][A-Za-z0-9-]*)/u)?.[1] ?? "diagram";
  }
  return "diagram";
}

export function diagramHash(source) {
  return createHash("sha256").update(source).digest("hex");
}

export function extractMermaidBlocks(markdown) {
  if (typeof markdown !== "string" || markdown.length === 0) return [];

  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const blocks = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const opening = lines[lineIndex].match(OPENING_FENCE);
    if (!opening) continue;

    const fence = opening[2];
    const fenceCharacter = fence[0];
    let closingIndex = -1;

    for (let candidate = lineIndex + 1; candidate < lines.length; candidate += 1) {
      const closing = lines[candidate].trim();
      if (
        closing.length >= fence.length &&
        closing.split("").every((character) => character === fenceCharacter)
      ) {
        closingIndex = candidate;
        break;
      }
    }

    if (closingIndex < 0) continue;

    const source = stripCommonIndent(lines.slice(lineIndex + 1, closingIndex));
    if (source.length > 0) {
      blocks.push({
        hash: diagramHash(source),
        source,
        type: diagramType(source),
      });
    }
    lineIndex = closingIndex;
  }

  return blocks;
}
