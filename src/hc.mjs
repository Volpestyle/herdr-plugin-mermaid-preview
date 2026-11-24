import { execFile } from "node:child_process";
import { access, open, readdir, readFile, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function hcBinary() {
  return process.env.HC_BIN_PATH || "hc";
}

export async function runHcJson(args) {
  const { stdout } = await execFileAsync(hcBinary(), [...args, "--json"], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

export async function hcTerminalInfo(terminalId) {
  const info = await runHcJson(["get", terminalId]);
  if (!info || !info.address) {
    throw new Error(`herdr-core did not return terminal information for ${terminalId}`);
  }
  return info;
}

export function encodeClaudeProjectDir(cwd) {
  return resolve(cwd).replace(/[^A-Za-z0-9-]/gu, "-");
}

function normalizeAgentName(value) {
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  if (!lower) return null;
  if (lower === "claude" || lower === "claude-code" || lower === "claude_code") return "claude";
  if (lower === "codex" || lower === "codex-cli" || lower === "codex-tui") return "codex";
  return lower;
}

function detectAgentFromArgv(argv) {
  if (!Array.isArray(argv)) return null;
  for (const token of argv) {
    if (typeof token !== "string") continue;
    const base = basename(token).toLowerCase();
    if (base === "claude" || token.includes("/.local/share/claude/versions/")) return "claude";
    if (base === "codex" || base === "codex-tui") return "codex";
  }
  return null;
}

export function detectHcAgent(info) {
  return (
    normalizeAgentName(info?.status?.app) ||
    normalizeAgentName(info?.labels?.["herdr.agent"]) ||
    normalizeAgentName(info?.labels?.["clankie.agent"]) ||
    detectAgentFromArgv(info?.foreground?.argv) ||
    detectAgentFromArgv(info?.argv) ||
    null
  );
}

function extractSessionFromArgv(argv, agent) {
  if (!Array.isArray(argv)) return null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (typeof arg !== "string") continue;
    if (arg === "--session-id" || arg === "--resume" || (agent === "claude" && arg === "-r")) {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) return next;
    }
    if (arg.startsWith("--session-id=")) return arg.slice("--session-id=".length) || null;
    if (arg.startsWith("--resume=")) return arg.slice("--resume=".length) || null;
    if (agent === "codex" && arg === "resume") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) return next;
    }
  }
  return null;
}

export function hcSessionHint(info) {
  const agent = detectHcAgent(info);
  const labels = info?.labels || {};
  const sessionPath = labels["herdr.session_path"] || null;
  const sessionId =
    labels["herdr.session_id"] ||
    labels["clankie.session"] ||
    extractSessionFromArgv(info?.foreground?.argv, agent) ||
    extractSessionFromArgv(info?.argv, agent) ||
    (sessionPath ? basename(sessionPath, ".jsonl") : null);
  const cwd = info?.foreground?.cwd || info?.cwd || null;
  const pids = [info?.foreground?.pid, info?.pid].filter(
    (value, index, array) => Number.isInteger(value) && value > 0 && array.indexOf(value) === index,
  );
  const createdMs = Number.isFinite(info?.created_ms) ? info.created_ms : null;

  return { agent, createdMs, cwd, pids, sessionId, sessionPath };
}

async function isReadable(path) {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function readFirstLine(path, maxBytes = 1024 * 1024) {
  const handle = await open(path, "r");
  try {
    const chunkSize = 32 * 1024;
    const chunks = [];
    let total = 0;

    while (total < maxBytes) {
      const toRead = Math.min(chunkSize, maxBytes - total);
      const buffer = Buffer.allocUnsafe(toRead);
      const { bytesRead } = await handle.read(buffer, 0, toRead, total);
      if (bytesRead === 0) break;
      const slice = buffer.subarray(0, bytesRead);
      const newline = slice.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(slice.subarray(0, newline));
        return Buffer.concat(chunks).toString("utf8");
      }
      chunks.push(slice);
      total += bytesRead;
    }

    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function findClaudePidSession(pids, claudeConfigDir) {
  for (const pid of pids) {
    const sessionFile = join(claudeConfigDir, "sessions", `${pid}.json`);
    if (!(await isReadable(sessionFile))) continue;
    try {
      const parsed = JSON.parse(await readFile(sessionFile, "utf8"));
      const sessionId = parsed?.sessionId || parsed?.session_id || null;
      const sessionPath = parsed?.transcriptPath || parsed?.transcript_path || null;
      if (sessionId || sessionPath) return { sessionId, sessionPath };
    } catch {
      // Ignore partial or unreadable PID session records.
    }
  }
  return null;
}

async function findLatestClaudeTranscriptForCwd(cwd, createdMs, claudeConfigDir) {
  if (!cwd) return null;
  const projectDir = join(claudeConfigDir, "projects", encodeClaudeProjectDir(cwd));
  let entries;
  try {
    entries = await readdir(projectDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const fullPath = join(projectDir, entry.name);
    try {
      const fileStat = await stat(fullPath);
      candidates.push({
        mtimeMs: fileStat.mtimeMs,
        path: fullPath,
        sessionId: basename(entry.name, ".jsonl"),
      });
    } catch {
      // Skip files that vanished between readdir and stat.
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (createdMs !== null) {
    const recent = candidates.find((candidate) => candidate.mtimeMs >= createdMs - 5_000);
    if (recent) return recent;
  }
  return candidates[0];
}

async function listCodexRolloutsNewestFirst(codexHome, limit = 60) {
  const root = join(codexHome, "sessions");
  const files = [];

  async function walk(directory, depth) {
    if (files.length >= limit) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries) {
      if (files.length >= limit) return;
      const fullPath = join(directory, entry.name);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(fullPath);
      } else if (entry.isDirectory() && depth < 4) {
        await walk(fullPath, depth + 1);
      }
    }
  }

  await walk(root, 0);
  return files;
}

async function findLatestCodexTranscriptForCwd(cwd, createdMs, codexHome) {
  if (!cwd) return null;
  const targetCwd = resolve(cwd);
  const files = await listCodexRolloutsNewestFirst(codexHome);
  let fallback = null;

  for (const filePath of files) {
    let firstLine;
    try {
      firstLine = await readFirstLine(filePath);
    } catch {
      continue;
    }
    if (!firstLine) continue;
    let record;
    try {
      record = JSON.parse(firstLine);
    } catch {
      continue;
    }
    if (record?.type !== "session_meta" || typeof record?.payload?.cwd !== "string") continue;
    if (resolve(record.payload.cwd) !== targetCwd) continue;

    const sessionId =
      record.payload.session_id || record.payload.id || basename(filePath, ".jsonl");
    const entry = { path: filePath, sessionId };
    if (!fallback) fallback = entry;

    if (createdMs === null) return entry;
    try {
      const fileStat = await stat(filePath);
      if (fileStat.mtimeMs >= createdMs - 5_000) return entry;
    } catch {
      // Continue scanning.
    }
  }

  return fallback;
}

export async function resolveHcSession(
  info,
  {
    claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
    codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"),
  } = {},
) {
  const hint = hcSessionHint(info);
  if (!hint.agent) {
    return { agent: null, sessionId: null, sessionPath: null };
  }
  if (hint.agent !== "claude" && hint.agent !== "codex") {
    return { agent: hint.agent, sessionId: hint.sessionId, sessionPath: hint.sessionPath };
  }
  if (hint.sessionId || hint.sessionPath) {
    return {
      agent: hint.agent,
      sessionId: hint.sessionId || basename(hint.sessionPath, ".jsonl"),
      sessionPath: hint.sessionPath,
    };
  }

  if (hint.agent === "claude") {
    const fromPid = await findClaudePidSession(hint.pids, claudeConfigDir);
    if (fromPid) {
      return {
        agent: "claude",
        sessionId: fromPid.sessionId || basename(fromPid.sessionPath, ".jsonl"),
        sessionPath: fromPid.sessionPath || null,
      };
    }
    const latest = await findLatestClaudeTranscriptForCwd(hint.cwd, hint.createdMs, claudeConfigDir);
    if (latest) {
      return { agent: "claude", sessionId: latest.sessionId, sessionPath: latest.path };
    }
  }

  if (hint.agent === "codex") {
    const latest = await findLatestCodexTranscriptForCwd(hint.cwd, hint.createdMs, codexHome);
    if (latest) {
      return { agent: "codex", sessionId: latest.sessionId, sessionPath: latest.path };
    }
  }

  return { agent: hint.agent, sessionId: null, sessionPath: null };
}
