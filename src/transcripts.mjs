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

/**
 * A base64 image content block, or null when it carries no usable bytes.
 *
 * Both harnesses elide image payloads once a transcript is compacted, leaving
 * the block in place with an empty source. Those are placeholders for an image
 * that is no longer recoverable, not images — roughly half of the blocks in a
 * long-lived project directory — so they never become preview items.
 */
function imagePayload(content) {
  if (content?.type === "image") {
    const source = content.source;
    if (source?.type !== "base64" || typeof source.data !== "string" || !source.data) return null;
    return { data: source.data, mediaType: source.media_type || null };
  }

  // Codex/OpenAI shape: a data URL rather than a discrete field.
  if (content?.type === "input_image" && typeof content.image_url === "string") {
    const match = content.image_url.match(/^data:([^;,]+);base64,(.+)$/su);
    if (!match) return null;
    return { data: match[2], mediaType: match[1] };
  }

  return null;
}

function claudeRecords(value) {
  const message = value.message;
  const base = value.uuid || message?.id || "claude-message";

  if (value.type === "assistant" && message?.role === "assistant") {
    return (message.content || [])
      .map((content, index) => ({ content, index }))
      .filter(({ content }) => content?.type === "text" && typeof content.text === "string")
      .map(({ content, index }) => ({ id: `${base}:${index}`, kind: "text", text: content.text }));
  }

  // Images reach the transcript as user-role content, which covers both what
  // you paste in and what the agent looked at with its read tool. The second
  // kind arrives one level down, inside the tool_result block that carries it —
  // reading only the top level finds the images you pasted and silently misses
  // every screenshot the agent took.
  if (value.type === "user" || value.type === "attachment") {
    const content = message?.content;
    if (!Array.isArray(content)) return [];

    const records = [];
    content.forEach((entry, index) => {
      const direct = imagePayload(entry);
      if (direct) {
        records.push({ id: `${base}:${index}`, kind: "image", ...direct });
        return;
      }
      if (entry?.type === "tool_result" && Array.isArray(entry.content)) {
        entry.content.forEach((nested, nestedIndex) => {
          const payload = imagePayload(nested);
          if (payload) {
            records.push({ id: `${base}:${index}.${nestedIndex}`, kind: "image", ...payload });
          }
        });
      }
    });
    return records;
  }

  return [];
}

function codexRecords(value) {
  if (value.type !== "response_item") return [];
  const payload = value.payload;
  if (!payload) return [];

  if (payload.type === "message") {
    const base = payload.id || "codex-message";

    if (payload.role === "assistant") {
      return (payload.content || [])
        .map((content, index) => ({ content, index }))
        .filter(({ content }) => content?.type === "output_text" && typeof content.text === "string")
        .map(({ content, index }) => ({ id: `${base}:${index}`, kind: "text", text: content.text }));
    }

    if (payload.role === "user") {
      return (payload.content || [])
        .map((entry, index) => ({ index, payload: imagePayload(entry) }))
        .filter(({ payload: found }) => found !== null)
        .map(({ index, payload: found }) => ({ id: `${base}:${index}`, kind: "image", ...found }));
    }
  }

  if (
    (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") &&
    Array.isArray(payload.output)
  ) {
    const base = payload.call_id || payload.id || "codex-tool-output";
    return payload.output
      .map((entry, index) => ({ index, payload: imagePayload(entry) }))
      .filter(({ payload: found }) => found !== null)
      .map(({ index, payload: found }) => ({ id: `${base}:${index}`, kind: "image", ...found }));
  }

  return [];
}

export function recordsFromJsonLine(line, agent) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return [];
  }

  if (agent === "codex") return codexRecords(value);
  if (agent === "claude") return claudeRecords(value);
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
