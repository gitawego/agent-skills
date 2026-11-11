import test from "node:test";
import assert from "node:assert/strict";
import { attentionOf } from "../scripts/lib/attention.mjs";

test("counts the human actions a campaign needed", () => {
  const events = [
    { type: "campaign.approved", data: { automatic: false } },
    { type: "campaign.approved", data: { automatic: true } },
    { type: "inbox.answered", data: { kind: "question" } },
    { type: "inbox.answered", data: { kind: "failure" } },
    { type: "inbox.answered", data: { kind: "review" } },
    { type: "branches.cleaned", data: { branches: ["orch/demo/01"] } },
    { type: "run.reported", data: {} },
  ];
  assert.deepEqual(attentionOf(events), { approvals: 1, answers: 2, reviews: 1, cleanups: 1, total: 5 });
});
