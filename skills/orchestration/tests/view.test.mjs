import test from "node:test";
import assert from "node:assert/strict";
import { deriveNextAction } from "../scripts/lib/view.mjs";

const base = { slug: "demo", tickets: [], inbox: [], planErrors: [], unboundKinds: [] };
const ticket = { id: "01", title: "One", kind: "code", stage: "queued" };

test("a draft with no tickets points at the plan draft", () => {
  const action = deriveNextAction({ ...base, stage: "draft" });
  assert.equal(action.actor, "you");
  assert.match(action.command, /plan draft demo/);
});

test("a draft with tickets and no chain points at the defaults", () => {
  const action = deriveNextAction({ ...base, stage: "draft", tickets: [ticket], unboundKinds: ["code"] });
  assert.match(action.text, /Bind the model chain/);
  assert.match(action.command, /defaults demo --apply/);
});

test("a planned campaign asks for approval", () => {
  const action = deriveNextAction({
    ...base,
    stage: "draft",
    tickets: [ticket],
    planErrors: [],
  });
  assert.match(action.command, /approve demo/);
  assert.equal(deriveNextAction({ ...base, stage: "awaiting_approval" }).actor, "you");
});

test("a pending draft points at the draft review", () => {
  const action = deriveNextAction({ ...base, stage: "draft", draft: { exists: true, error: null } });
  assert.match(action.command, /plan diff demo/);
  const broken = deriveNextAction({ ...base, stage: "draft", draft: { exists: true, error: "bad yaml" } });
  assert.match(broken.text, /invalid/);
});

test("a running campaign is the supervisor's until a person is needed", () => {
  assert.equal(deriveNextAction({ ...base, stage: "running" }).actor, "supervisor");
  const question = deriveNextAction({
    ...base,
    stage: "running",
    inbox: [{ status: "open", kind: "needs_answer", ticket: "02", id: "q-1" }],
  });
  assert.equal(question.actor, "worker");
  assert.match(question.command, /answer q-1/);
  const review = deriveNextAction({
    ...base,
    stage: "running",
    inbox: [{ status: "open", kind: "review", id: "r-2" }],
  });
  assert.equal(review.actor, "you");
  assert.match(review.command, /review r-2 approve/);
});

test("paused, delivered and archived each name the right handoff", () => {
  assert.match(deriveNextAction({ ...base, stage: "paused" }).command, /resume demo/);
  assert.match(deriveNextAction({ ...base, stage: "delivered" }).command, /archive demo/);
  assert.equal(deriveNextAction({ ...base, stage: "archived" }).actor, "none");
});
