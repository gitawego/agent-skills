// Worktrees, the integration branch, merges, and delivery.
import fs from "node:fs";
import path from "node:path";
import { campaignWorktreesDir, ensureDir, exists, git, readText } from "./util.mjs";

export function integrationBranch(slug) {
  return `orch/${slug}/integration`;
}

export function ticketBranch(slug, ticketId) {
  return `orch/${slug}/${ticketId}`;
}

export function integrationWorktree(root, slug) {
  return path.join(campaignWorktreesDir(root, slug), "_integration");
}

export function ticketWorktree(root, slug, ticketId) {
  return path.join(campaignWorktreesDir(root, slug), String(ticketId));
}

export function ensureIntegration(root, slug, base) {
  const dir = integrationWorktree(root, slug);
  const branch = integrationBranch(slug);
  if (git(dir, ["rev-parse", "--verify", "--quiet", "HEAD"]).ok) return { dir, branch };
  ensureDir(path.dirname(dir));
  const existing = git(root, ["rev-parse", "--verify", "--quiet", branch]).ok;
  const args = existing ? ["worktree", "add", dir, branch] : ["worktree", "add", "-B", branch, dir, base];
  const res = git(root, args, { timeout: 120_000 });
  if (!res.ok) throw new Error(`could not prepare the integration branch: ${res.stderr || res.stdout}`);
  return { dir, branch };
}

export function ensureTicketWorktree(root, slug, ticketId, base) {
  const dir = ticketWorktree(root, slug, ticketId);
  const branch = ticketBranch(slug, ticketId);
  if (exists(dir) && git(dir, ["rev-parse", "--verify", "--quiet", "HEAD"]).ok) {
    git(dir, ["checkout", branch]);
    return { dir, branch, reused: true };
  }
  ensureDir(path.dirname(dir));
  const branchExists = git(root, ["rev-parse", "--verify", "--quiet", branch]).ok;
  const args = branchExists ? ["worktree", "add", dir, branch] : ["worktree", "add", "-b", branch, dir, base];
  const res = git(root, args, { timeout: 120_000 });
  if (!res.ok) throw new Error(`could not prepare the worktree for ${ticketId}: ${res.stderr || res.stdout}`);
  return { dir, branch, reused: false };
}

export function mergeTicket(root, slug, ticketId) {
  const { dir } = ensureIntegration(root, slug, "HEAD");
  const branch = ticketBranch(slug, ticketId);
  const status = git(dir, ["status", "--porcelain"]);
  if (status.stdout) {
    return { ok: false, conflict: false, output: `the integration worktree is dirty:\n${status.stdout}` };
  }
  const res = git(dir, ["merge", "--no-ff", "--no-edit", branch], { timeout: 120_000 });
  if (res.ok) return { ok: true, output: res.stdout };
  const conflict = /conflict/i.test(`${res.stdout}\n${res.stderr}`);
  git(dir, ["merge", "--abort"]);
  return { ok: false, conflict, output: `${res.stdout}\n${res.stderr}`.trim() };
}

export function diffStats(root, slug, base) {
  const branch = integrationBranch(slug);
  const res = git(root, ["diff", "--shortstat", `${base}...${branch}`]);
  const text = res.stdout || "";
  const added = Number((text.match(/(\d+) insertion/) || [])[1] || 0);
  const removed = Number((text.match(/(\d+) deletion/) || [])[1] || 0);
  return { added, removed, lines: added + removed, text };
}

export function deliverBranch(root, slug, { base, allowMerge }) {
  const branch = integrationBranch(slug);
  if (!allowMerge) {
    return { mode: "manual", ok: true, branch, detail: `branch ${branch} is ready to merge into ${base}` };
  }
  const head = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (head.stdout !== base) {
    return { mode: "manual", ok: true, branch, detail: `the checkout is on ${head.stdout || "no branch"}, not ${base}` };
  }
  const ownPlan = `orchestration/${slug}/`;
  const dirty = git(root, ["status", "--porcelain", "-uall"])
    .stdout.split("\n")
    .map((line) => line.replace(/^\S{1,2}\s+/, "").trim())
    .filter(Boolean)
    .filter((file) => file !== ownPlan && !file.startsWith(ownPlan))
    /* machine state is ignored even in a project that never added the line */
    .filter((file) => file !== ".orchestration" && !file.startsWith(".orchestration/"));
  if (dirty.length) {
    return { mode: "manual", ok: true, branch, detail: `uncommitted changes: ${dirty.slice(0, 5).join(", ")}` };
  }
  const ff = git(root, ["merge", "--ff-only", branch], { timeout: 120_000 });
  if (ff.ok) return { mode: "merged", ok: true, branch, detail: ff.stdout || `fast-forwarded ${base}` };

  const merge = git(root, ["merge", "--no-ff", "--no-edit", branch], { timeout: 120_000 });
  if (merge.ok) return { mode: "merged", ok: true, branch, detail: `merged with a merge commit: ${merge.stdout || ""}`.trim() };
  git(root, ["merge", "--abort"]);
  return { mode: "manual", ok: true, branch, detail: `the delivery will not merge cleanly: ${merge.stderr || merge.stdout}` };
}

export function writeManifest(root, slug, tickets, workdir) {
  const dir = path.join(root, "orchestration", slug, "deliverables");
  ensureDir(dir);
  const lines = [
    `# ${slug} delivery`,
    "",
    `Generated ${new Date().toISOString()}`,
    "",
    "| Ticket | Title | Kind |",
    "| --- | --- | --- |",
    ...tickets.map((t) => `| ${t.data.id} | ${t.title} | ${t.data.kind} |`),
    "",
  ];
  const file = path.join(dir, "manifest.md");
  fs.writeFileSync(file, lines.join("\n"));
  return file;
}

/* A finished ticket no longer needs its worktree: done is terminal, and the
   ticket branch is already merged into the integration branch. The branch is
   kept as the exact pointer; only the checkout is removed. */
export function removeTicketWorktree(root, slug, ticketId) {
  const worktree = ticketWorktree(root, slug, ticketId);
  if (!exists(worktree)) return false;
  const res = git(root, ["worktree", "remove", "--force", worktree], { timeout: 60_000 });
  if (!res.ok) git(root, ["worktree", "prune"]);
  return true;
}

/* Delivery removes any remaining worktree checkouts but keeps every ticket
   branch and the integration branch. Branch names are cheap; they are the
   exact pointers into the integration history. */
export function pruneWorktrees(root, slug) {
  const dir = campaignWorktreesDir(root, slug);
  if (!exists(dir)) return [];
  const removed = [];
  for (const entry of fs.readdirSync(dir)) {
    if (entry === "_integration") continue;
    const worktree = path.join(dir, entry);
    const res = git(root, ["worktree", "remove", "--force", worktree], { timeout: 60_000 });
    if (!res.ok) git(root, ["worktree", "prune"]);
    removed.push(entry);
  }
  return removed;
}

const SKIP_DIRS = new Set([".git", ".orchestration", "orchestration", "node_modules", ".pi"]);

/* Directory landing has no branch to diff, so the run records the tree before
   it starts and the supervisor compares it afterwards. */
export function snapshotDir(root, limit = 5000) {
  const files = {};
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (Object.keys(files).length >= limit) return;
      if (entry.name.startsWith(".") && entry.name !== ".env") continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) {
        try {
          const stat = fs.statSync(full);
          files[rel] = `${stat.size}:${Math.round(stat.mtimeMs)}`;
        } catch {
          /* a file that vanished mid-walk is not a change we can judge */
        }
      }
    }
  };
  walk(root, "");
  return files;
}

export function changedSince(root, before) {
  const after = snapshotDir(root);
  const changed = [];
  for (const [file, stamp] of Object.entries(after)) {
    if (!before || before[file] !== stamp) changed.push(file);
  }
  if (before) {
    for (const file of Object.keys(before)) {
      if (!(file in after)) changed.push(file);
    }
  }
  return changed;
}

export function readIfExists(file) {
  return readText(file, null);
}
