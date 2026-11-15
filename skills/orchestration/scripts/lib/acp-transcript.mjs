// Normalize an ACP run log into the same readable shape as a pi transcript.
// ACP update payloads are agent-defined; this keeps the common message, tool
// and plan events and ignores anything it does not understand.
import fs from "node:fs";
import path from "node:path";
import { projectStateDir } from "./util.mjs";

function textOf(content) {
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && !Array.isArray(content) && typeof content.text === "string") return content.text;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

function mergeMessage(messages, role, text, extra = {}) {
  const value = String(text || "").trim();
  if (!value && !extra.toolCalls) return;
  const previous = messages[messages.length - 1];
  if (previous && previous.role === role && !extra.toolCalls && !previous.toolCalls?.length) {
    previous.text = `${previous.text}${previous.text ? "\n" : ""}${value}`;
    return;
  }
  messages.push({ role, text: value, toolCalls: extra.toolCalls || [], toolName: extra.toolName || null, toolCallId: extra.toolCallId || null });
}

export function parseAcpTranscript(text) {
  const messages = [];
  let session = null;
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "acp.session") {
      session = { ...(session || {}), id: event.sessionId || null, mode: event.mode || null };
      continue;
    }
    if (event.type === "acp.config") {
      session = { ...(session || {}), [event.id]: event.value };
      continue;
    }
    if (event.type !== "acp.update") continue;
    const update = event.update || {};
    const kind = update.sessionUpdate || update.type || "";
    if (kind === "agent_message_chunk" || kind === "user_message_chunk") {
      mergeMessage(messages, kind.startsWith("user") ? "user" : "assistant", textOf(update.content));
    } else if (kind === "agent_thought_chunk") {
      mergeMessage(messages, "thinking", textOf(update.content));
    } else if (kind === "tool_call") {
      messages.push({
        role: "tool",
        text: String(update.title || update.kind || "tool call"),
        toolCalls: [{ name: update.title || update.kind || "tool", args: { status: update.status || "" } }],
        toolName: update.kind || "tool",
        toolCallId: update.toolCallId || null,
      });
    } else if (kind === "tool_call_update") {
      const existing = messages.find((message) => message.toolCallId && message.toolCallId === update.toolCallId);
      if (existing) {
        existing.text = `${existing.text}${update.status ? ` · ${update.status}` : ""}`;
      } else {
        messages.push({ role: "tool", text: update.title || update.status || "tool update", toolCalls: [], toolName: "tool", toolCallId: update.toolCallId || null });
      }
    } else if (kind === "plan") {
      const entries = Array.isArray(update.entries) ? update.entries : [];
      mergeMessage(messages, "plan", entries.map((entry) => `${entry.status ? `[${entry.status}] ` : ""}${entry.content || ""}`).join("\n"));
    }
  }
  return { session, total: messages.length, messages };
}

export function readAcpTranscript({ root, campaign, run }) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(campaign) || !/^[A-Za-z0-9._-]+$/.test(run) || run.includes("..")) return null;
  const file = path.join(projectStateDir(root), "campaigns", campaign, "runs", run, "log.jsonl");
  const runsDir = path.join(projectStateDir(root), "campaigns", campaign, "runs");
  if (!file.startsWith(runsDir + path.sep)) return null;
  try {
    return { file, ...parseAcpTranscript(fs.readFileSync(file, "utf8")) };
  } catch {
    return null;
  }
}
