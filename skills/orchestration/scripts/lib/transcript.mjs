// Read a pi session JSONL into a compact, model-facing transcript.
// The session file is the conversation; the run log is the supervisor's
// telemetry. This module never invents a message that is not on disk.
import fs from "node:fs";
import { sessionFileFor } from "./runs.mjs";

const DEFAULT_MAX_MESSAGES = 300;
const DEFAULT_MAX_TEXT = 20_000;
const DEFAULT_MAX_TOOL_RESULT = 6_000;

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function toolCallsOf(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((part) => part?.type === "toolCall" && part.name)
    .map((part) => ({
      name: String(part.name),
      args: part.arguments && typeof part.arguments === "object" ? part.arguments : {},
    }));
}

function clip(text, max) {
  const value = String(text || "");
  if (value.length <= max) return { text: value, truncated: false };
  return { text: `${value.slice(0, max)}\n… truncated …`, truncated: true };
}

export function parseTranscript(text, { maxMessages = DEFAULT_MAX_MESSAGES, maxText = DEFAULT_MAX_TEXT, maxToolResult = DEFAULT_MAX_TOOL_RESULT } = {}) {
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
    if (event.type === "session") {
      session = {
        id: event.id || null,
        cwd: event.cwd || null,
        version: event.version || null,
        createdAt: event.timestamp || null,
      };
      continue;
    }
    if (event.type === "model_change") {
      session = { ...(session || {}), provider: event.provider || null, model: event.modelId || null };
      continue;
    }
    if (event.type === "thinking_level_change") {
      session = { ...(session || {}), thinking: event.thinkingLevel || null };
      continue;
    }
    if (event.type !== "message") continue;
    const message = event.message || {};
    const role = message.role || "unknown";
    const body = role === "toolResult" ? textOf(message.content) : textOf(message.content);
    const tools = toolCallsOf(message.content);
    if (!body.trim() && !tools.length) continue;
    const limit = role === "toolResult" ? maxToolResult : maxText;
    const clipped = clip(body, limit);
    messages.push({
      role,
      ts: event.timestamp || null,
      text: clipped.text,
      truncated: clipped.truncated,
      toolCalls: tools,
      toolName: message.toolName || null,
      toolCallId: message.toolCallId || null,
    });
  }
  const total = messages.length;
  return {
    session,
    total,
    messages: total > maxMessages ? messages.slice(-maxMessages) : messages,
    truncated: total > maxMessages,
  };
}

export function readTranscript({ sessionsDir, sessionId, maxMessages, maxText, maxToolResult }) {
  const file = sessionFileFor(sessionsDir, sessionId);
  if (!file) return null;
  const text = fs.readFileSync(file, "utf8");
  return { file, ...parseTranscript(text, { maxMessages, maxText, maxToolResult }) };
}
