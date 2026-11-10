import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { workerPrompt, reviewPrompt, judgePrompt, mergePrompt, systemPromptFiles, systemPromptDigest, promptDigest } from "../scripts/lib/prompts.mjs";

const TICKET = {
  what: "Build the thing.",
  criteria: [{ text: "The thing works." }],
  touches: ["src/thing/**"],
};

test("every role has a contract file and the contract comes first", () => {
  for (const role of ["code", "design", "visual", "research", "plan", "chores", "review", "judge", "merge"]) {
    const files = systemPromptFiles(role);
    assert.equal(files.length, 2);
    assert.match(files[0], /references\/contract\.md$/);
    assert.match(files[1], new RegExp(`references/roles/${role}\\.md$`));
    for (const file of files) assert.ok(fs.existsSync(file), `${file} exists`);
  }
});

test("a custom kind falls back to the general role", () => {
  const files = systemPromptFiles("docs");
  assert.match(files[1], /roles\/general\.md$/);
});

test("the worker prompt interpolates every placeholder", () => {
  const text = workerPrompt({
    campaign: "demo",
    ticket: "03",
    ticketTitle: "The thing",
    runId: "r-1",
    workdir: "/tmp/wt",
    base: "main",
    kind: "code",
    decisions: [],
    sections: { brief: "Because.", constraints: "None." },
    data: TICKET,
  });
  assert.doesNotMatch(text, /\{\{[A-Z_]+\}\}/);
  assert.match(text, /kind: code/);
});

test("the review prompt names the diff to read instead of leaving a placeholder", () => {
  const text = reviewPrompt({
    campaign: "demo",
    ticket: "03",
    ticketTitle: "The thing",
    runId: "r-1",
    workdir: "/tmp/wt",
    base: "main",
    kind: "code",
    data: TICKET,
    landing: "branch",
  });
  assert.doesNotMatch(text, /\{\{[A-Z_]+\}\}/);
  assert.match(text, /git diff --stat main\.\.\.HEAD/);
  assert.match(text, /git diff main\.\.\.HEAD/);
});

test("the judge and merge prompts interpolate every placeholder", () => {
  const judge = judgePrompt({
    campaign: "demo",
    ticket: "03",
    ticketTitle: "The thing",
    question: { text: "Which one?" },
    summary: "Tried both.",
    sections: {},
    data: TICKET,
    decisions: [],
  });
  assert.doesNotMatch(judge, /\{\{[A-Z_]+\}\}/);
  const merge = mergePrompt({ root: "/tmp/wt", slug: "demo", ticket: "03", conflict: "CONFLICT (content)" });
  assert.doesNotMatch(merge, /\{\{[A-Z_]+\}\}/);
  assert.match(merge, /CONFLICT \(content\)/);
});

test("the prompt digest is stable and content-addressed", () => {
  assert.equal(promptDigest("a"), promptDigest("a"));
  assert.notEqual(promptDigest("a"), promptDigest("b"));
  assert.match(promptDigest("a"), /^[a-f0-9]{64}$/);
});

test("the system prompt digest changes with the role, not the path", () => {
  const code = systemPromptDigest(systemPromptFiles("code"));
  const design = systemPromptDigest(systemPromptFiles("design"));
  assert.match(code, /^[a-f0-9]{64}$/);
  assert.notEqual(code, design);
});
