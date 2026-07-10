import assert from "node:assert/strict";
import test from "node:test";
import { sessionIdentity } from "../src/session.mjs";

test("reads stock Herdr's normalized session identity", () => {
  assert.deepEqual(
    sessionIdentity({
      agent_session: {
        agent: "codex",
        kind: "id",
        source: "herdr:codex",
        value: "session-123",
      },
    }),
    { agent: "codex", sessionId: "session-123", sessionPath: null },
  );
});

test("prefers raw session fields when Herdr provides them", () => {
  assert.deepEqual(
    sessionIdentity({
      agent: "claude",
      agent_session: {
        agent: "claude",
        kind: "id",
        source: "herdr:claude",
        value: "normalized-id",
      },
      agent_session_id: "raw-id",
      agent_session_path: "/tmp/raw-id.jsonl",
    }),
    {
      agent: "claude",
      sessionId: "raw-id",
      sessionPath: "/tmp/raw-id.jsonl",
    },
  );
});

test("derives the transcript id from a path session reference", () => {
  assert.deepEqual(
    sessionIdentity({
      agent_session: {
        agent: "claude",
        kind: "path",
        source: "herdr:claude",
        value: "/tmp/session-456.jsonl",
      },
    }),
    {
      agent: "claude",
      sessionId: "session-456",
      sessionPath: "/tmp/session-456.jsonl",
    },
  );
});
