import assert from "node:assert/strict";
import test from "node:test";
import { diagramType, extractMermaidBlocks } from "../src/mermaid.mjs";

test("extracts complete Mermaid fences and ignores other code", () => {
  const markdown = [
    "before",
    "```js",
    "console.log('not mermaid')",
    "```",
    "```mermaid",
    "flowchart LR",
    "  A --> B",
    "```",
  ].join("\n");

  const blocks = extractMermaidBlocks(markdown);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].source, "flowchart LR\n  A --> B");
  assert.equal(blocks[0].type, "flowchart");
});

test("waits for the closing fence", () => {
  assert.deepEqual(extractMermaidBlocks("```mermaid\nflowchart LR\nA-->B"), []);
});

test("supports indented and tilde fences with multiple diagrams", () => {
  const blocks = extractMermaidBlocks(
    "  ~~~mermaid\n    sequenceDiagram\n      A->>B: Hello\n  ~~~\n\n````mermaid\nstateDiagram-v2\nA --> B\n````",
  );

  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].source, "sequenceDiagram\n  A->>B: Hello");
  assert.equal(blocks[1].type, "stateDiagram-v2");
});

test("finds the first meaningful Mermaid directive", () => {
  assert.equal(diagramType("%% comment\n\nflowchart TD\nA-->B"), "flowchart");
});
