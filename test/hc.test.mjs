import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  detectHcAgent,
  encodeClaudeProjectDir,
  hcSessionHint,
  resolveHcSession,
} from "../src/hc.mjs";

test("detects Claude Code and Codex from hc status, labels, or argv", () => {
  assert.equal(detectHcAgent({ status: { app: "claude-code" } }), "claude");
  assert.equal(detectHcAgent({ status: { app: "codex" } }), "codex");
  assert.equal(detectHcAgent({ labels: { "clankie.agent": "claude" } }), "claude");
  assert.equal(
    detectHcAgent({
      foreground: { argv: ["/Users/alice/.local/share/claude/versions/2.1.330"] },
    }),
    "claude",
  );
  assert.equal(detectHcAgent({ argv: ["/opt/homebrew/bin/codex", "--no-daemon"] }), "codex");
  assert.equal(detectHcAgent({ status: { app: "antigravity" } }), "antigravity");
});

test("extracts explicit session hints from labels and CLI arguments", () => {
  const fromLabel = hcSessionHint({
    cwd: "/tmp/work",
    labels: { "clankie.session": "de1738b7-f109-494f-8204-9f4e5c910212" },
    status: { app: "claude-code" },
  });
  assert.equal(fromLabel.agent, "claude");
  assert.equal(fromLabel.sessionId, "de1738b7-f109-494f-8204-9f4e5c910212");

  const fromClaudeArgv = hcSessionHint({
    foreground: {
      argv: ["claude", "--session-id", "sess-from-flag"],
      cwd: "/tmp/work",
      pid: 4242,
    },
  });
  assert.equal(fromClaudeArgv.agent, "claude");
  assert.equal(fromClaudeArgv.sessionId, "sess-from-flag");
  assert.deepEqual(fromClaudeArgv.pids, [4242]);

  const fromCodexResume = hcSessionHint({
    foreground: {
      argv: ["codex", "resume", "01a20058-1cac-7f73-a06b-8985d1a241f8"],
      cwd: "/tmp/work",
    },
  });
  assert.equal(fromCodexResume.agent, "codex");
  assert.equal(fromCodexResume.sessionId, "01a20058-1cac-7f73-a06b-8985d1a241f8");
});

test("resolves Claude transcript from PID session record when present", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-hc-claude-pid-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  await mkdir(join(root, "sessions"), { recursive: true });
  const transcriptPath = join(root, "projects", "-tmp-demo", "pid-session-1.jsonl");
  await mkdir(join(root, "projects", "-tmp-demo"), { recursive: true });
  await writeFile(transcriptPath, "", "utf8");
  await writeFile(
    join(root, "sessions", "7777.json"),
    JSON.stringify({ sessionId: "pid-session-1", transcriptPath }),
    "utf8",
  );

  const resolved = await resolveHcSession(
    {
      cwd: "/tmp/demo",
      foreground: { argv: ["claude"], cwd: "/tmp/demo", pid: 7777 },
      status: { app: "claude-code" },
    },
    { claudeConfigDir: root },
  );

  assert.deepEqual(resolved, {
    agent: "claude",
    sessionId: "pid-session-1",
    sessionPath: transcriptPath,
  });
});

test("resolves newest Claude transcript in matching encoded project directory", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-hc-claude-cwd-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  const cwd = join(root, "repo.work", "sub");
  const projectDir = join(root, "projects", encodeClaudeProjectDir(cwd));
  await mkdir(projectDir, { recursive: true });

  const older = join(projectDir, "older-session.jsonl");
  const newer = join(projectDir, "newer-session.jsonl");
  await writeFile(older, "{}\n", "utf8");
  await writeFile(newer, "{}\n", "utf8");
  const now = Date.now() / 1000;
  await utimes(older, now - 120, now - 120);
  await utimes(newer, now - 1, now - 1);

  const resolved = await resolveHcSession(
    {
      created_ms: Date.now() - 10_000,
      cwd,
      status: { app: "claude-code" },
    },
    { claudeConfigDir: root },
  );

  assert.deepEqual(resolved, {
    agent: "claude",
    sessionId: "newer-session",
    sessionPath: newer,
  });
});

test("resolves Codex rollout transcript matching terminal cwd via session_meta", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-hc-codex-cwd-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  const dayDir = join(root, "sessions", "2026", "11", "24");
  await mkdir(dayDir, { recursive: true });

  const otherCwd = join(root, "other");
  const targetCwd = join(root, "target-repo");
  const otherFile = join(dayDir, "rollout-2026-11-24T10-00-00-other.jsonl");
  const matchFile = join(dayDir, "rollout-2026-11-24T09-00-00-match.jsonl");

  await writeFile(
    otherFile,
    `${JSON.stringify({ type: "session_meta", payload: { cwd: otherCwd, id: "other-id" } })}\n`,
    "utf8",
  );
  await writeFile(
    matchFile,
    `${JSON.stringify({
      type: "session_meta",
      payload: {
        base_instructions: "x".repeat(40_000),
        cwd: targetCwd,
        id: "match-id",
      },
    })}\n`,
    "utf8",
  );

  const resolved = await resolveHcSession(
    {
      created_ms: Date.now() - 60_000,
      cwd: targetCwd,
      status: { app: "codex" },
    },
    { codexHome: root },
  );

  assert.deepEqual(resolved, {
    agent: "codex",
    sessionId: "match-id",
    sessionPath: matchFile,
  });
});
