import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  JsonlFollower,
  recordsFromJsonLine,
  resolveTranscript,
} from "../src/transcripts.mjs";

test("reads assistant Markdown from a Codex response item", () => {
  const line = JSON.stringify({
    type: "response_item",
    payload: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "```mermaid\nflowchart LR\nA-->B\n```" }],
    },
  });

  assert.deepEqual(recordsFromJsonLine(line, "codex"), [
    { id: "msg_1:0", kind: "text", text: "```mermaid\nflowchart LR\nA-->B\n```" },
  ]);
});

test("reads assistant Markdown from a Claude transcript entry", () => {
  const line = JSON.stringify({
    type: "assistant",
    uuid: "uuid-1",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "```mermaid\nsequenceDiagram\nA->>B: Hi\n```" }],
    },
  });

  assert.deepEqual(recordsFromJsonLine(line, "claude"), [
    { id: "uuid-1:0", kind: "text", text: "```mermaid\nsequenceDiagram\nA->>B: Hi\n```" },
  ]);
});

test("ignores tool entries, user messages, and malformed JSON", () => {
  assert.deepEqual(recordsFromJsonLine("not json", "codex"), []);
  assert.deepEqual(
    recordsFromJsonLine(JSON.stringify({ type: "assistant", message: { role: "user" } }), "claude"),
    [],
  );
});

test("follows assistant records appended to a JSONL transcript", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mermaid-transcript-test-"));
  const path = join(directory, "session.jsonl");
  await writeFile(path, "", "utf8");
  context.after(async () => rm(directory, { recursive: true, force: true }));

  const follower = new JsonlFollower(path, "codex");
  context.after(() => follower.close());
  const recordPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for transcript record")), 2_000);
    follower.once("record", (record) => {
      clearTimeout(timeout);
      resolve(record);
    });
  });
  await follower.start();

  await appendFile(
    path,
    `${JSON.stringify({
      type: "response_item",
      payload: {
        id: "msg_live",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "```mermaid\nflowchart TD\nA-->B\n```" }],
      },
    })}\n`,
  );

  assert.deepEqual(await recordPromise, {
    id: "msg_live:0",
    kind: "text",
    text: "```mermaid\nflowchart TD\nA-->B\n```",
  });
});

test("prefers Herdr's authoritative custom transcript path", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mermaid-custom-transcript-test-"));
  const sessionId = "session-custom-root";
  const path = join(directory, `${sessionId}.jsonl`);
  await writeFile(path, "", "utf8");
  context.after(async () => rm(directory, { recursive: true, force: true }));

  assert.equal(
    await resolveTranscript({ agent: "claude", sessionId, sessionPath: path }),
    path,
  );
});
