// Run one ACP agent turn for the orchestration supervisor.
// The supervisor spawns this helper; it speaks ACP to the harness, streams
// progress into the run log, writes session.json, and exits when the turn ends.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect, initialize } from "./lib/acp-client.mjs";
import { profile } from "./lib/acp-profiles.mjs";
import { wrapCommand } from "./lib/sandbox.mjs";

const specPath = process.argv[2];
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
/* The spec carries base64 image payloads; keep it out of the run directory. */
fs.rmSync(specPath, { force: true });
const p = profile(spec.adapter);
const log = fs.createWriteStream(spec.logFile, { flags: "a" });

const extraEnv = {};
if (p.systemPrompt === "agent-config" && spec.systemPrompt) {
  extraEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    default_agent: "orchestration-worker",
    agent: {
      "orchestration-worker": { prompt: spec.systemPrompt, mode: "primary" },
    },
  });
}

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

let replaying = false;
const wrapped = wrapCommand({
  command: p.command,
  args: p.args,
  cwd: spec.cwd,
  rwPaths: [path.dirname(spec.logFile)],
  mode: spec.sandbox || "auto",
});
const client = connect({
  command: wrapped.command,
  args: wrapped.args,
  cwd: spec.cwd,
  env: extraEnv,
  onStderr: (text) => record({ type: "acp.stderr", text: text.trim().slice(0, 2000) }),
  onNotification: (msg) => {
    if (replaying) return;
    if (msg.method === "session/update") {
      record({ type: "acp.update", update: msg.params?.update || null });
    }
  },
  onPermission: (msg) => {
    const tool = msg.params?.toolCall || {};
    const paths = [
      ...(tool.locations || []).map((location) => location.path),
      tool.rawInput?.path,
      tool.rawInput?.file_path,
      tool.rawInput?.cwd,
    ].filter((value) => typeof value === "string" && value.length);
    const roots = [path.resolve(spec.cwd), os.tmpdir()];
    const outside = paths.filter((file) => {
      const abs = path.resolve(spec.cwd, file);
      return !roots.some((root) => abs === root || abs.startsWith(root + path.sep));
    });
    /* Commands are not a full sandbox, but an absolute path outside the
       worktree/tmp/system roots is a clear escape and is refused. */
    const command = String(tool.rawInput?.command || "");
    const systemRoots = [...roots, "/usr", "/bin", "/lib", "/lib64", "/opt", "/nix", "/dev", "/proc"];
    const escapes = [...command.matchAll(/(?:^|\s)((?:\/|\.\.\/)[^\s"'`;&|]+)/g)]
      .map((match) => match[1])
      .filter((token) => {
        const abs = path.resolve(spec.cwd, token);
        return !systemRoots.some((root) => abs === root || abs.startsWith(root + path.sep));
      });
    const options = msg.params?.options || [];
    const allow = options.find((option) => /allow/i.test(`${option.optionId} ${option.name}`)) || options[0];
    if (outside.length || escapes.length) {
      record({ type: "acp.permission", decision: "deny", paths: [...outside, ...escapes] });
      return null;
    }
    record({ type: "acp.permission", decision: "allow", paths });
    return allow?.optionId || null;
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
  const documents = Array.isArray(spec.documents) ? spec.documents : [];
  if (images.length && !caps.promptCapabilities?.image) {
    throw new Error(`adapter "${spec.adapter}" does not support image prompts`);
  }
  if (documents.length && !caps.promptCapabilities?.embeddedContext) {
    throw new Error(`adapter "${spec.adapter}" does not support embedded documents`);
  }
  const systemParam =
    spec.promptMode === "meta" && spec.systemPrompt
      ? { _meta: { antigravity: { systemPrompt: { append: spec.systemPrompt } } } }
      : {};

  let session;
  let sessionMode = "new";
  try {
    if (spec.sessionId && caps.loadSession) {
      sessionMode = "load";
      replaying = true;
      session = await client.request("session/load", {
        sessionId: spec.sessionId,
        cwd: spec.cwd,
        mcpServers: [],
        ...systemParam,
      });
      replaying = false;
      session = { ...session, sessionId: spec.sessionId };
      record({ type: "acp.session", mode: "load", sessionId: spec.sessionId });
    } else if (spec.sessionId && caps.sessionCapabilities?.resume) {
      sessionMode = "resume";
      session = await client.request("session/resume", {
        sessionId: spec.sessionId,
        cwd: spec.cwd,
        mcpServers: [],
        ...systemParam,
      });
      session = { ...session, sessionId: spec.sessionId };
      record({ type: "acp.session", mode: "resume", sessionId: spec.sessionId });
    } else {
      sessionMode = "new";
      session = await client.request("session/new", { cwd: spec.cwd, mcpServers: [], ...systemParam });
      record({ type: "acp.session", mode: "new", sessionId: session.sessionId });
    }
  } catch (err) {
    /* A changed adapter or an expired server-side session must not dead-end
       the ticket; start fresh and record why. */
    replaying = false;
    record({ type: "acp.session.fallback", message: err.message });
    sessionMode = "new";
    session = await client.request("session/new", { cwd: spec.cwd, mcpServers: [], ...systemParam });
    record({ type: "acp.session", mode: "new-after-fallback", sessionId: session.sessionId });
  }

  const options = session.configOptions || [];
  const byId = Object.fromEntries(options.map((o) => [o.id, o]));
  const applied = {};

  async function setConfig(id, value, { required = false } = {}) {
    if (!id || value == null) return;
    const option = byId[id];
    if (!option) return;
    if (option.currentValue === value) {
      applied[id] = option.currentValue;
      return;
    }
    const allowed = (option.options || []).map((o) => o.value);
    if (allowed.length && !allowed.includes(value)) {
      applied[id] = option.currentValue;
      return;
    }
    try {
      await client.request("session/set_config_option", {
        sessionId: session.sessionId,
        configId: id,
        value,
      });
      applied[id] = value;
      record({ type: "acp.config", id, value });
    } catch (err) {
      applied[id] = option.currentValue;
      record({ type: "acp.config.error", id, value, message: err.message });
      if (required) throw err;
    }
  }

  await setConfig(p.modelConfig, spec.modelConfigValue, { required: true });
  await setConfig(p.thinkingConfig, clampThinking((byId[p.thinkingConfig]?.options || []).map((o) => o.value), spec.thinking));
  if (p.systemPrompt !== "agent-config") await setConfig(p.modeConfig, spec.mode);

  const prompt =
    spec.promptMode === "prefix" && spec.systemPrompt
      ? `${spec.systemPrompt}\n\n---\n\n${spec.prompt}`
      : spec.prompt;
  permissionNote(`auto-approve adapter=${spec.adapter} nonce=${spec.nonce}`);
  /* A loaded session already holds the images; resending them only burns
     tokens. A fresh/fallback session needs them again. */
  const resend = sessionMode !== "load" && sessionMode !== "resume";
  const outgoing = resend ? images : [];
  const outgoingDocs = resend ? documents : [];
  const content = [
    { type: "text", text: prompt },
    ...outgoing.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType })),
    ...outgoingDocs.map((document) => ({
      type: "resource",
      resource: {
        uri: `attachment://${encodeURIComponent(document.path)}`,
        mimeType: document.mimeType,
        blob: document.data,
      },
    })),
  ];
  if (outgoing.length || outgoingDocs.length) {
    record({ type: "acp.attachments", files: [...outgoing, ...outgoingDocs].map((item) => item.path) });
  }
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
        config: applied,
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
