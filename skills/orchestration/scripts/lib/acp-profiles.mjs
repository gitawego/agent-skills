// Harness-specific ACP details. A profile is data; the transport is shared.
export const PROFILES = {
  "agy-acp": {
    id: "agy-acp",
    label: "Antigravity ACP",
    command: "agy",
    args: ["acp", "--dangerously-skip-permissions"],
    provider: "antigravity",
    billing: "subscription",
    includedProviders: null, // every advertised model is included
    systemPrompt: "meta", // _meta.antigravity.systemPrompt.append
    modelConfig: "model",
    thinkingConfig: "thought_level",
    modeConfig: "mode",
    mode: "auto",
    thinking: ["low", "medium", "high"],
    imageMetadata: "adapter", // the server advertises image input; models are not listed individually
  },
  "opencode-acp": {
    id: "opencode-acp",
    label: "OpenCode ACP",
    command: "opencode",
    args: ["acp"],
    provider: null, // provider/model comes from the model id
    billing: "metered",
    includedProviders: ["opencode-go"],
    systemPrompt: "agent-config", // OPENCODE_CONFIG_CONTENT default_agent prompt
    modelConfig: "model",
    thinkingConfig: "effort",
    modeConfig: "mode",
    mode: "build",
    thinking: ["default", "low", "medium", "high"],
    imageMetadata: "model", // enriched per model from the local price store
  },
};

export function profile(adapter) {
  const found = PROFILES[adapter];
  if (!found) throw new Error(`unknown ACP adapter "${adapter}"`);
  return found;
}

export function splitModel(profile, value) {
  if (profile.provider) return { provider: profile.provider, model: value };
  const at = String(value).indexOf("/");
  if (at < 0) return { provider: "unknown", model: value };
  return { provider: value.slice(0, at), model: value.slice(at + 1) };
}

/* The value the harness expects in its model config option. */
export function modelConfigValue(profile, provider, model) {
  return profile.provider ? model : `${provider}/${model}`;
}
