# AGENT.md

Project conventions for AI agents working in this repo.

This repo holds reusable skills under `skills/`. Each skill is a self-contained
folder (`SKILL.md` + optional `scripts/`, `assets/`, `evals/`, `references/`,
`docs/`) that should be portable: clone or copy it anywhere, install the
documented dependencies, and it should work the same.

## What a skill folder is — and is not

A skill is **declarative content** (SKILL.md, JSON manifests, sample assets,
optional helper scripts). It is **not** a runnable project.

Concretely, a clean skill folder looks like:

```
skills/<skill-name>/
├── SKILL.md           # required: frontmatter (name, description) + instructions
├── assets/            # optional: sample inputs the skill uses for self-tests
├── evals/             # optional: eval prompts and grading data
├── references/        # optional: long-form docs the model reads on demand
├── docs/              # optional: design notes, change logs, planning
└── scripts/           # optional: deterministic scripts the skill invokes
```

That's the entire surface area. No `package.json`, no `node_modules`, no
lockfiles, no `tmp/`, no `dist/`, no `.env`, no `__pycache__/`, no
`*.pyc`, no `.venv/`.

## Do not commit dependency artifacts to the skill folder

Skills are consumed by other projects. Whatever the user installs in their
own project is what they should use — the skill should not dictate it.

**Never do any of these inside a skill folder:**

```bash
# ❌ installs 45 MB of node_modules into the skill — not portable, not needed
cd skills/my-skill && npm install
cd skills/my-skill && npm install --save sharp canvas
cd skills/my-skill && yarn add ...

# ❌ creates a Python virtualenv or cache inside the skill
cd skills/my-skill && python3 -m venv .venv
cd skills/my-skill && pip install -r requirements.txt
cd skills/my-skill && python3 -m pytest  # writes __pycache__/

# ❌ adds a package manifest that the skill doesn't need
cd skills/my-skill && npm init -y
cd skills/my-skill && pip freeze > requirements.txt
```

If a skill has helper scripts that import third-party packages, document the
dependencies in SKILL.md (under a "Dependencies" or "Setup" section) and let
the user install them in **their own project root**. Example from the
`image-sprites-creator` skill:

```bash
# the user runs this in THEIR project, not inside the skill folder
cd /path/to/their/project
npm install sharp canvas
python3 -m pip install --user "rembg[cpu]" onnxruntime
```

If you need to test scripts locally during development, install the deps
**one directory above** the skill so `node_modules` resolves through Node's
parent-directory lookup:

```bash
cd skills/        # parent of the skill
npm install sharp canvas   # shared across all skills in this folder
node my-skill/scripts/foo.mjs ...   # imports resolve upward
```

## Do not create "workspace" or scratch directories next to `skills/`

The skill-creator workflow recommends a `workspace/` folder next to the
skills tree for iteration artifacts (snapshots, summary files, grader
output). That's fine **inside a temp directory** while iterating, but it
should not become a permanent part of the repo.

```bash
# ❌ leaving this committed
agent-skills/
├── skills/
└── workspace/        # ← don't keep this after the iteration is done
    ├── skill-snapshot/
    └── iteration-1-summary.md
```

If you follow the skill-creator loop, run it under `/tmp` or under a
`.scratch/` folder that's gitignored. When the iteration is done and the
improvements have landed in `skills/<name>/`, delete the workspace.

## Do not write temporary files into the skill folder

Skill folders are clean, declarative content. Pipelines produce output
into `tmp/` (the user's `tmp/`, not the skill's). When testing a skill:

```bash
# ✅ run the pipeline somewhere outside the skill
mkdir -p /tmp/skill-test && cd /tmp/skill-test
node /path/to/skill/scripts/extract-cells.mjs --source ... --out raw ...
python3 /path/to/skill/scripts/remove-bg.py raw clean
node /path/to/skill/scripts/build-atlas.mjs --in clean --out atlas ...

# ❌ running it inside the skill folder leaves tmp/ and intermediate PNGs
cd skills/my-skill && mkdir -p tmp && node scripts/extract-cells.mjs ...
# → leaves tmp/ full of raw crops, clean frames, and the atlas inside the skill
```

## What a PR / commit touching a skill should look like

- Modified: `SKILL.md`, scripts under `scripts/`, manifests under `evals/`,
  notes under `docs/`, sample inputs under `assets/` or `evals/files/`.
- Not modified: `package.json`, `package-lock.json`, `node_modules/`, `tmp/`,
  `__pycache__/`, `.venv/`, `dist/`, `*.pyc`, `*.log`.

Run `git status` before committing. If you see any of the above in the
diff, stop and fix the workflow — those files belong in the user's
project, not in the skill.

## When a skill is hard to test, add an eval

If you're tempted to leave a script in a half-tested state because "the
sample inputs are weird," add a sample input to `evals/files/` and a
matching prompt to `evals/evals.json`. The next person who touches the
skill will then have a reproducible way to confirm it still works.

## Where the canonical skill source lives

`/mnt/data/workspace/agent-skills/skills/` is the source of truth.
`/home/hlu/.agents/skills/` is a *consumed* copy that mirrors the same
files. If you change a skill, edit it in the source-of-truth location and
sync to the consumer copy. Don't edit the consumer copy directly — the
next skill-loading pass will overwrite it.
