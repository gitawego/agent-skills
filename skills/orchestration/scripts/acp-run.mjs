// Run one ACP agent turn for the orchestration supervisor.
// The supervisor spawns this helper; it speaks ACP to the harness, streams
// progress into the run log, writes session.json, and exits when the turn ends.
import fs from "node:fs";
import path from "node:path";
import { connect, initialize } from "./lib/acp-client.mjs";
import { profile } from "./lib/acp-profiles.mjs";

const specPath = process.argv[2];
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
/* The spec carries base64 image payloads; keep it out of the run directory. */
fs.rmSync(specPath, { force: true });
const p = profile(spec.adapter);
const log = fs.createWriteStream(spec.logFile, { flags: "a" });

function record(event) {
  log.write(JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
}

function clampThinking(values, wanted) {
  if (!values || !values.length) return null;
  if (values.includes(wanted)) return wanted;
  const map = { minimal: "low", xhigh: "high", max: "high" };
  const mapped = map[wanted] || wanted;
  if (values.includes(mapped)) return mapped;
  if (values.includes("default")) return "default";
  return null;
}

const client = connect({
  command: p.command,
  args: p.args,
  cwd: spec.cwd,
  onStderr: (text) => record({ type: "acp.stderr", text: text.trim().slice(0, 2000) }),
  onNotification: (msg) => {
    if (msg.method === "session/update") {
      record({ type: "acp.update", update: msg.params?.update || null });
    }
  },
});

function permissionNote(line) {
  try {
    fs.appendFileSync(spec.permissionLog, line + "\n");
  } catch {
    /* permissions are advisory */
  }
}

try {
  const init = await initialize(client, { name: "orchestration", version: "1" });
  const caps = init.agentCapabilities || {};
  const images = Array.isArray(spec.images) ? spec.images : [];
  if (images.length && !caps.promptCapabilities?.image) {
    throw new Error(`adapter "${spec.adapter}" does not support image prompts`);
  }
  const systemParam =
    spec.promptMode === "meta" && spec.systemPrompt
      ? { _meta: { antigravity: { systemPrompt: { append: spec.systemPrompt } } } }
      : {};

  let session;
  try {
    if (spec.sessionId && caps.loadSession) {
      session = await client.request("session/load", {
        sessionId: spec.sessionId,
        cwd: spec.cwd,
        mcpServers: [],
        ...systemParam,
      });
      session = { ...session, sessionId: spec.sessionId };
      record({ type: "acp.session", mode: "load", sessionId: spec.sessionId });
    } else if (spec.sessionId && caps.sessionCapabilities?.resume) {
      session = await client.request("session/resume", {
        sessionId: spec.sessionId,
        cwd: spec.cwd,
        mcpServers: [],
        ...systemParam,
      });
      session = { ...session, sessionId: spec.sessionId };
      record({ type: "acp.session", mode: "resume", sessionId: spec.sessionId });
    } else {
      session = await client.request("session/new", { cwd: spec.cwd, mcpServers: [], ...systemParam });
      record({ type: "acp.session", mode: "new", sessionId: session.sessionId });
    }
  } catch (err) {
    /* A changed adapter or an expired server-side session must not dead-end
       the ticket; start fresh and record why. */
    record({ type: "acp.session.fallback", message: err.message });
    session = await client.request("session/new", { cwd: spec.cwd, mcpServers: [], ...systemParam });
    record({ type: "acp.session", mode: "new-after-fallback", sessionId: session.sessionId });
  }

  const options = session.configOptions || [];
  const byId = Object.fromEntries(options.map((o) => [o.id, o]));

  async function setConfig(id, value, { required = false } = {}) {
    if (!id || value == null) return;
    const option = byId[id];
    if (!option) return;
    if (option.currentValue === value) return;
    const allowed = (option.options || []).map((o) => o.value);
    if (allowed.length && !allowed.includes(value)) return;
    try {
      await client.request("session/set_config_option", {
        sessionId: session.sessionId,
        configId: id,
        value,
      });
      record({ type: "acp.config", id, value });
    } catch (err) {
      record({ type: "acp.config.error", id, value, message: err.message });
      if (required) throw err;
    }
  }

  await setConfig(p.modelConfig, spec.modelConfigValue, { required: true });
  await setConfig(p.thinkingConfig, clampThinking((byId[p.thinkingConfig]?.options || []).map((o) => o.value), spec.thinking));
  await setConfig(p.modeConfig, spec.mode);

  const prompt =
    spec.promptMode === "prefix" && spec.systemPrompt
      ? `${spec.systemPrompt}\n\n---\n\n${spec.prompt}`
      : spec.prompt;

  permissionNote(`auto-approve adapter=${spec.adapter} nonce=${spec.nonce}`);
  const content = [
    { type: "text", text: prompt },
    ...images.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType })),
  ];
  if (images.length) record({ type: "acp.images", files: images.map((image) => image.path) });
  const result = await client.request(
    "session/prompt",
    { sessionId: session.sessionId, prompt: content },
    24 * 60 * 60 * 1000,
  );

  const usage = result.usage || null;
  fs.writeFileSync(
    spec.sessionFile,
    JSON.stringify(
      {
        sessionId: session.sessionId,
        stopReason: result.stopReason || null,
        usage,
        adapter: spec.adapter,
        model: `${spec.provider}/${spec.model}`,
        at: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
  record({ type: "usage", usage, stopReason: result.stopReason || null });
  await client.request("session/close", { sessionId: session.sessionId }).catch(() => {});
} catch (err) {
  record({ type: "acp.error", message: err.message });
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await client.close();
  log.end();
}
