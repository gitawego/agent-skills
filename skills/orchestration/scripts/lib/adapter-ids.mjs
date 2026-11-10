export const ADAPTER_IDS = ["pi", "agy-acp", "opencode-acp"];

export const DEFAULT_ADAPTER = "pi";

/* OpenCode Go and Antigravity are subscription products: by default the picker
   only offers models included in the plan. `metered-ok` is an explicit opt-in. */
export const DEFAULT_SPEND = {
  "opencode-acp": "subscription-only",
  "agy-acp": "subscription-only",
  pi: "metered-ok",
};

export const SPEND_MODES = ["subscription-only", "metered-ok"];
