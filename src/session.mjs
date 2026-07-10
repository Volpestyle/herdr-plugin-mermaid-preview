import { basename } from "node:path";

export function sessionIdentity(info) {
  const session = info.agent_session;
  const agent = info.agent || session?.agent || null;
  const sessionPath =
    info.agent_session_path || (session?.kind === "path" ? session.value : null);
  const sessionId =
    info.agent_session_id ||
    (session?.kind === "id" ? session.value : null) ||
    (sessionPath ? basename(sessionPath, ".jsonl") : null);

  return { agent, sessionId, sessionPath };
}
