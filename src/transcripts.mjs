import { EventEmitter } from "node:events";
import { constants as fsConstants, unwatchFile, watchFile } from "node:fs";
import {
  access,
  open,
  readdir,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

const SESSION_ID = /^[A-Za-z0-9._-]+$/u;
const READ_CHUNK_BYTES = 64 * 1024;

async function isReadable(path) {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function findFile(root, matches, maxDepth = 5) {
  const queue = [{ depth: 0, path: root }];

  while (queue.length > 0) {
    const current = queue.shift();
    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const path = join(current.path, entry.name);
      if (entry.isFile() && matches(entry.name)) return path;
      if (entry.isDirectory() && current.depth < maxDepth) {
        queue.push({ depth: current.depth + 1, path });
      }
    }
  }

  return null;
}

export async function resolveTranscript({ agent, sessionId, sessionPath = null }) {
  if (!SESSION_ID.test(sessionId)) {
    throw new Error("Herdr reported an invalid agent session id");
  }

  if (sessionPath) {
    const filename = basename(sessionPath);
    const matchesSession =
      filename.endsWith(".jsonl") &&
      (filename === `${sessionId}.jsonl` || filename.includes(sessionId));
    if (!isAbsolute(sessionPath) || !matchesSession) {
      throw new Error("Herdr reported an invalid agent session transcript path");
    }
    if (await isReadable(sessionPath)) return sessionPath;
  }

  if (agent === "codex") {
    const root = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
    return findFile(root, (name) => name.endsWith(".jsonl") && name.includes(sessionId), 5);
  }

  if (agent === "claude") {
    const root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
    const exactName = `${sessionId}.jsonl`;
    return findFile(root, (name) => name === exactName, 3);
  }

  throw new Error(`Unsupported agent: ${agent}`);
}

export function recordsFromJsonLine(line, agent) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return [];
  }

  if (
    agent === "codex" &&
    value.type === "response_item" &&
    value.payload?.type === "message" &&
    value.payload?.role === "assistant"
  ) {
    return (value.payload.content || [])
      .map((content, index) => ({ content, index }))
      .filter(({ content }) => content?.type === "output_text" && typeof content.text === "string")
      .map(({ content, index }) => ({
        id: `${value.payload.id || "codex-message"}:${index}`,
        text: content.text,
      }));
  }

  if (agent === "claude" && value.type === "assistant" && value.message?.role === "assistant") {
    return (value.message.content || [])
      .map((content, index) => ({ content, index }))
      .filter(({ content }) => content?.type === "text" && typeof content.text === "string")
      .map(({ content, index }) => ({
        id: `${value.uuid || value.message.id || "claude-message"}:${index}`,
        text: content.text,
      }));
  }

  return [];
}

export class JsonlFollower extends EventEmitter {
  #agent;
  #busy = false;
  #closed = false;
  #offset = 0;
  #path;
  #pending = Buffer.alloc(0);
  #rerun = false;

  constructor(path, agent) {
    super();
    this.#path = path;
    this.#agent = agent;
  }

  async start() {
    if (!(await isReadable(this.#path))) {
      throw new Error(`Transcript is not readable: ${this.#path}`);
    }
    await this.#consume();
    watchFile(this.#path, { interval: 250 }, () => {
      void this.#consume();
    });
  }

  close() {
    this.#closed = true;
    unwatchFile(this.#path);
  }

  async #consume() {
    if (this.#closed) return;
    if (this.#busy) {
      this.#rerun = true;
      return;
    }

    this.#busy = true;
    try {
      const fileStat = await stat(this.#path);
      if (fileStat.size < this.#offset) {
        this.#offset = 0;
        this.#pending = Buffer.alloc(0);
      }
      if (fileStat.size === this.#offset) return;

      const handle = await open(this.#path, "r");
      try {
        while (this.#offset < fileStat.size) {
          const bytesToRead = Math.min(READ_CHUNK_BYTES, fileStat.size - this.#offset);
          const buffer = Buffer.allocUnsafe(bytesToRead);
          const { bytesRead } = await handle.read(buffer, 0, bytesToRead, this.#offset);
          if (bytesRead === 0) break;
          this.#offset += bytesRead;
          this.#pending = Buffer.concat([this.#pending, buffer.subarray(0, bytesRead)]);
          this.#emitCompleteLines();
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      this.emit("error", error);
    } finally {
      this.#busy = false;
      if (this.#rerun) {
        this.#rerun = false;
        void this.#consume();
      }
    }
  }

  #emitCompleteLines() {
    let newlineIndex = this.#pending.indexOf(0x0a);
    while (newlineIndex >= 0) {
      const line = this.#pending.subarray(0, newlineIndex).toString("utf8");
      this.#pending = this.#pending.subarray(newlineIndex + 1);
      for (const record of recordsFromJsonLine(line, this.#agent)) {
        this.emit("record", record);
      }
      newlineIndex = this.#pending.indexOf(0x0a);
    }
  }
}

export function transcriptLabel(path) {
  return basename(path, ".jsonl");
}
