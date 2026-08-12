#!/usr/bin/env bun
// setup-omp-statusline.mjs
//
// Captures the full omp customizations applied for a narrow (Termux/phone)
// terminal, idempotently. Safe to re-run.
//
// What it ensures (relative to agent dir, default ~/.omp/agent, overridable
// via PI_CODING_AGENT_DIR):
//   1. themes/titanium-cache.json — custom theme = builtin "titanium" colors
//      + symbols.overrides["icon.cache"] = 🗃️ (card file box instead of the
//      floppy disk). Also sets config.yml theme.dark to it.
//   2. config.yml — statusLine.* + theme.dark via SECTION-LEVEL TEXT PATCH:
//      only the `statusLine:` and `theme:` blocks are touched; every other
//      line (comments, order, formatting, unknown keys) is preserved
//      byte-for-byte. A timestamped .bak-* copy is written before any change.
//   3. models.yml — REMOVES the opencode-go/deepseek-v4-flash display-name
//      override (full discovered model name shows; the status line drops the
//      whole model segment when it doesn't fit — no text cut). Comments and
//      other entries are preserved; .bak-* written before any change.
//
// Run:  bun scripts/setup-omp-statusline.mjs
// Requires bun (present wherever omp runs; omp itself uses Bun's YAML).

import { YAML } from "bun";
import * as fs from "node:fs";
import * as path from "node:path";

const HOME = process.env.HOME ?? "";
const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(HOME, ".omp", "agent");

// ── status line patch (deep-merged into config.yml) ────────────────────────
// Valid segment ids (settings-schema StatusLineSegmentId): pi, model, mode,
// path, git, pr, subagents, token_in, token_out, token_total, token_rate,
// cost, context_pct, context_total, time_spent, time, session, hostname,
// cache_read, cache_write, cache_hit, session_name, usage, collab.
// Narrow-width drop order (component.ts): right segments first, then left
// segments from the END of the array, then path shrinks. Keep the phone set
// first; append wide-screen-only segments after.
const CONFIG_PATCH = {
	statusLine: {
		preset: "custom",
		separator: "none", // space-only; powerline chevrons cost ~2 cols each
		transparent: true, // drops powerline end caps (2 cols)
		compactThinkingLevel: true,
		showHookStatus: true,
		leftSegments: ["git", "mode", "cache_hit", "context_pct", "model"],
		rightSegments: ["session_name"],
		segmentOptions: {
			model: { showThinkingLevel: true },
			path: { abbreviate: true, maxLength: 12, stripWorkPrefix: true },
			git: { showBranch: true, showStaged: false, showUnstaged: false, showUntracked: false },
		},
	},
	theme: { dark: "titanium-cache" },
};

// ── titanium-cache theme (builtin titanium colors + icon override) ─────────
const THEME = {
	$schema: "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/theme-schema.json",
	name: "titanium-cache",
	vars: {
		brushedTitanium: "#151820",
		darkTitanium: "#0f1216",
		electricBlue: "#00b4ff",
		deepBlue: "#0082b3",
		titaniumGold: "#d4c090",
		brightAluminum: "#e8ecf4",
		dimAluminum: "#9ca3b0",
		warningAmber: "#ffb347",
		readoutGreen: "#00ff88",
		alertRed: "#ff4757",
		subtleGray: "#2a3038",
	},
	colors: {
		accent: "electricBlue",
		border: "subtleGray",
		borderAccent: "electricBlue",
		borderMuted: "#1f252d",
		success: "readoutGreen",
		error: "alertRed",
		warning: "warningAmber",
		muted: "dimAluminum",
		dim: "#6b7280",
		text: "",
		thinkingText: "dimAluminum",
		selectedBg: "deepBlue",
		userMessageBg: "darkTitanium",
		userMessageText: "",
		customMessageBg: "subtleGray",
		customMessageText: "",
		customMessageLabel: "titaniumGold",
		toolPendingBg: "darkTitanium",
		toolSuccessBg: "darkTitanium",
		toolErrorBg: "#1a0f10",
		toolTitle: "",
		toolOutput: "dimAluminum",
		mdHeading: "electricBlue",
		mdLink: "electricBlue",
		mdLinkUrl: "deepBlue",
		mdCode: "readoutGreen",
		mdCodeBlock: "dimAluminum",
		mdCodeBlockBorder: "subtleGray",
		mdQuote: "dimAluminum",
		mdQuoteBorder: "subtleGray",
		mdHr: "subtleGray",
		mdListBullet: "electricBlue",
		toolDiffAdded: "readoutGreen",
		toolDiffRemoved: "alertRed",
		toolDiffContext: "dimAluminum",
		syntaxComment: "#6b7280",
		syntaxKeyword: "electricBlue",
		syntaxFunction: "readoutGreen",
		syntaxVariable: "brightAluminum",
		syntaxString: "titaniumGold",
		syntaxNumber: "warningAmber",
		syntaxType: "electricBlue",
		syntaxOperator: "electricBlue",
		syntaxPunctuation: "dimAluminum",
		thinkingOff: "#4a5058",
		thinkingMinimal: "#5a6068",
		thinkingLow: "#6a7078",
		thinkingMedium: "dimAluminum",
		thinkingHigh: "electricBlue",
		thinkingXhigh: "titaniumGold",
		bashMode: "readoutGreen",
		statusLineBg: "darkTitanium",
		statusLineSep: "subtleGray",
		statusLineModel: "electricBlue",
		statusLinePath: "brightAluminum",
		statusLineGitClean: "readoutGreen",
		statusLineGitDirty: "warningAmber",
		statusLineContext: "dimAluminum",
		statusLineSpend: "titaniumGold",
		statusLineStaged: "readoutGreen",
		statusLineDirty: "warningAmber",
		statusLineUntracked: "dimAluminum",
		statusLineOutput: "deepBlue",
		statusLineCost: "titaniumGold",
		statusLineSubagents: "electricBlue",
		pythonMode: "#f0c040",
	},
	symbols: {
		overrides: {
			// U+1F5C3 U+FE0F card file box — beats the floppy (U+1F4BE) for cache.
			// Other candidates: 💠 U+1F4A0, 📦 U+1F4E6; nerd preset uses FA database.
			"icon.cache": "🗃️",
		},
	},
	export: {
		pageBg: "brushedTitanium",
		cardBg: "darkTitanium",
		infoBg: "subtleGray",
	},
};

// ── helpers ─────────────────────────────────────────────────────────────────
function deepMerge(base, patch) {
	for (const [k, v] of Object.entries(patch)) {
		if (
			v && typeof v === "object" && !Array.isArray(v) &&
			base[k] && typeof base[k] === "object" && !Array.isArray(base[k])
		) {
			deepMerge(base[k], v);
		} else {
			base[k] = v;
		}
	}
	return base;
}

function readOr(file, fallback) {
	try {
		return fs.readFileSync(file, "utf8");
	} catch (err) {
		if (err?.code === "ENOENT") return fallback;
		throw err;
	}
}

function writeAtomic(file, content) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = file + ".tmp";
	fs.writeFileSync(tmp, content);
	fs.renameSync(tmp, file);
}

/** Copy the original aside before any modification of a user config file. */
function backup(file) {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	fs.copyFileSync(file, `${file}.bak-${stamp}`);
	return `${file}.bak-${stamp}`;
}

// ── line-oriented YAML section patching ─────────────────────────────────────
// These helpers patch only the named mapping block, leaving every other line
// (comments, ordering, formatting, unknown keys) byte-identical.

/** Indices of the lines belonging to the `key:` mapping block starting at startIdx. */
function blockSpan(lines, startIdx) {
	const indent = lines[startIdx].match(/^\s*/)[0].length;
	let end = startIdx + 1;
	while (end < lines.length) {
		const l = lines[end];
		if (l.trim() === "") { end++; continue; } // blank lines don't end a YAML mapping
		if (l.match(/^\s*/)[0].length <= indent) break;
		end++;
	}
	return { indent, end };
}

/** Re-indent YAML child lines (from YAML.stringify of a subtree) by baseIndent. */
function indentChildren(serialized, baseIndent) {
	const pad = " ".repeat(baseIndent);
	return serialized
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => pad + l)
		.join("\n");
}

/**
 * Replace the children of top-level mapping `key` with `childrenText`
 * (pre-indented, no trailing newline). Creates the block if missing.
 * Returns { ok, text, changed }. `ok: false` → structure unexpected (e.g.
 * inline flow mapping) → caller must fall back to full rewrite.
 */
function replaceMappingBlock(text, key, childrenText) {
	const lines = text.split("\n");
	const re = new RegExp(`^(\\s*)${key}:\\s*(.*)$`);
	const idx = lines.findIndex((l) => re.test(l));
	if (idx < 0) {
		// Insert at end of file, top-level.
		const insert = [`${key}:`, ...childrenText.split("\n")];
		const sep = text.trim() === "" ? "" : "\n";
		return { ok: true, text: text.replace(/\s*$/, "") + sep + "\n" + insert.join("\n") + "\n", changed: true };
	}
	const indent = lines[idx].match(re)[1];
	const inline = lines[idx].match(re)[2].trim();
	const emptyContainer = inline === "" || inline === "{}" || inline === "[]";
	if (!emptyContainer) {
		// Scalar or populated flow mapping — structure we don't own; refuse so
		// the caller falls back to a deep-merged full rewrite.
		return { ok: false, text, changed: false };
	}
	const { end } = blockSpan(lines, idx);
	const oldChildren = lines.slice(idx + 1, end).filter((l) => l.trim() !== "");
	const newChildren = childrenText.split("\n");
	if (JSON.stringify(oldChildren) === JSON.stringify(newChildren)) {
		return { ok: true, text, changed: false };
	}
	// Expand an inline `{}`/`[]` marker into a proper block header.
	const header = inline === "" ? lines[idx] : `${indent}${key}:`;
	const out = [...lines.slice(0, idx), header, ...newChildren, ...lines.slice(end)];
	return { ok: true, text: out.join("\n"), changed: true };
}

/**
 * Ensure `parentKey:` block (top-level) has a scalar child `childKey: value`.
 * Preserves other children and all outside content.
 * Returns { ok, text, changed }.
 */
function setMappingScalar(text, parentKey, childKey, value) {
	const lines = text.split("\n");
	const re = new RegExp(`^(\\s*)${parentKey}:\\s*(.*)$`);
	const idx = lines.findIndex((l) => re.test(l));
	const valueStr = String(value);
	if (idx < 0) {
		const insert = [`${parentKey}:`, `  ${childKey}: ${valueStr}`];
		const sep = text.trim() === "" ? "" : "\n";
		return { ok: true, text: text.replace(/\s*$/, "") + sep + "\n" + insert.join("\n") + "\n", changed: true };
	}
	const indent = lines[idx].match(re)[1];
	const inline = lines[idx].match(re)[2].trim();
	const emptyContainer = inline === "" || inline === "{}" || inline === "[]";
	if (!emptyContainer) {
		// Scalar or populated flow mapping — refuse rather than guess.
		return { ok: false, text, changed: false };
	}
	const { end } = blockSpan(lines, idx);
	const childRe = new RegExp(`^(\\s+)${childKey}:\\s*(.*)$`);
	const cIdx = lines.slice(idx + 1, end).findIndex((l) => childRe.test(l));
	if (cIdx >= 0) {
		const li = idx + 1 + cIdx;
		const m = lines[li].match(childRe);
		if (m[2].trim() === valueStr) return { ok: true, text, changed: false };
		lines[li] = `${m[1]}${childKey}: ${valueStr}`;
		return { ok: true, text: lines.join("\n"), changed: true };
	}
	// Insert child as the first child of the block; expand an inline marker.
	const header = inline === "" ? lines[idx] : `${indent}${parentKey}:`;
	const childLine = `${" ".repeat(indent.length + 2)}${childKey}: ${valueStr}`;
	const out = [...lines.slice(0, idx), header, childLine, ...lines.slice(idx + 1)];
	return { ok: true, text: out.join("\n"), changed: true };
}

// ── 1. theme ────────────────────────────────────────────────────────────────
const changed = [];
const themePath = path.join(agentDir, "themes", "titanium-cache.json");
const themeJson = JSON.stringify(THEME, null, "\t") + "\n";
if (readOr(themePath, "") !== themeJson) {
	writeAtomic(themePath, themeJson);
	changed.push(themePath);
}

// ── 2. config.yml — section-level patch, never a full overwrite ─────────────
const configPath = path.join(agentDir, "config.yml");
const configRaw = readOr(configPath, null);

if (configRaw === null) {
	// Fresh install: create the file with only our keys; omp fills defaults.
	const fresh = YAML.stringify(CONFIG_PATCH, null, 2) + "\n";
	writeAtomic(configPath, fresh);
	changed.push(configPath + " (created)");
} else {
	let parsed;
	try {
		parsed = YAML.parse(configRaw);
	} catch (err) {
		console.error(`setup-omp-statusline: config.yml is not valid YAML — aborting (${err})`);
		process.exit(1);
	}
	if (!parsed || typeof parsed !== "object") {
		console.error("setup-omp-statusline: config.yml root is not a mapping — aborting");
		process.exit(1);
	}

	// Desired merged values (deep merge keeps the user's existing keys).
	const merged = deepMerge(structuredClone(parsed), CONFIG_PATCH);
	const slText = indentChildren(YAML.stringify(merged.statusLine, null, 2), 2);

	// Patch `statusLine:` block in place.
	let r1 = replaceMappingBlock(configRaw, "statusLine", slText);
	let out = r1.text;
	let dirty = r1.changed;

	// Patch `theme.dark` in place.
	const r2 = setMappingScalar(out, "theme", "dark", CONFIG_PATCH.theme.dark);
	if (r2.ok) {
		out = r2.text;
		dirty = dirty || r2.changed;
	}

	// Fallback: structure we can't patch (inline flow mappings) → full rewrite
	// with a backup, keeping the deep-merged values (comments would be lost —
	// reported).
	let fellBack = false;
	if (!r1.ok || !r2.ok) {
		const full = YAML.stringify(merged, null, 2) + "\n";
		if (full !== configRaw) {
			out = full;
			dirty = true;
			fellBack = true;
		}
	}

	// Sanity: the patched text must still parse and round-trip to the same
	// merged values; otherwise refuse to write.
	if (dirty) {
		let check;
		try {
			check = YAML.parse(out);
		} catch (err) {
			console.error(`setup-omp-statusline: patch produced invalid YAML — aborting, file untouched (${err})`);
			process.exit(1);
		}
		const want = JSON.stringify(merged);
		const got = JSON.stringify(check);
		if (want !== got) {
			console.error("setup-omp-statusline: patch round-trip mismatch — aborting, file untouched");
			console.error(`  want: ${want}`);
			console.error(`  got : ${got}`);
			process.exit(1);
		}
		const bak = backup(configPath);
		writeAtomic(configPath, out);
		changed.push(configPath + ` (patched; backup: ${path.basename(bak)})`);
		if (fellBack) {
			console.warn("setup-omp-statusline: WARNING — config.yml used inline flow mappings; rewrote the whole file (deep-merged). Comments in config.yml, if any, were lost. Backup kept.");
		}
	}
}

// ── 3. models.yml — REMOVE the deepseek-v4-flash display-name override ──────
// Targeted line removal: preserves the comment header and any other entries
// (e.g. gpt-5.6-luna). Fresh installs never create models.yml — no override.
const MODEL_KEY = "deepseek-v4-flash";
const modelsPath = path.join(agentDir, "models.yml");
const modelsRaw = readOr(modelsPath, null);

function removeModelOverride(text) {
	const lines = text.split("\n");
	const dIdx = lines.findIndex((l) => new RegExp(`^\\s*${MODEL_KEY}:\\s*$`).test(l));
	if (dIdx < 0) return text; // nothing to remove
	const dIndent = lines[dIdx].match(/^\s*/)[0].length;
	let end = dIdx + 1;
	while (end < lines.length) {
		const l = lines[end];
		if (l.trim() === "") break;
		const ind = l.match(/^\s*/)[0].length;
		if (ind <= dIndent) break;
		end++;
	}
	lines.splice(dIdx, end - dIdx);
	return lines.join("\n");
}

if (modelsRaw !== null) {
	try {
		YAML.parse(modelsRaw); // sanity: never mutate an unparsable file
	} catch (err) {
		console.error(`setup-omp-statusline: models.yml is not valid YAML — aborting (${err})`);
		process.exit(1);
	}
	const effective = (() => {
		try {
			const p = YAML.parse(modelsRaw);
			return p?.providers?.["opencode-go"]?.modelOverrides?.[MODEL_KEY] !== undefined;
		} catch {
			return false;
		}
	})();
	if (effective) {
		const next = removeModelOverride(modelsRaw);
		if (next !== modelsRaw) {
			const bak = backup(modelsPath);
			writeAtomic(modelsPath, next);
			changed.push(modelsPath + ` (removed ${MODEL_KEY} name override; backup: ${path.basename(bak)})`);
		}
	}
}

// ── report ──────────────────────────────────────────────────────────────────
if (changed.length === 0) {
	console.log("setup-omp-statusline: already applied — nothing changed.");
} else {
	for (const f of changed) console.log(`setup-omp-statusline: wrote ${f}`);
}
console.log(`status line: ${CONFIG_PATCH.statusLine.leftSegments.join(", ")} | ${CONFIG_PATCH.statusLine.rightSegments.join(", ")}`);
console.log(`theme.dark: ${CONFIG_PATCH.theme.dark} | cache icon: ${THEME.symbols.overrides["icon.cache"]}`);
console.log("Takes effect on the next omp launch.");
