import test from "node:test";
import assert from "node:assert/strict";
import { buildContextPacket } from "../scripts/lib/context-packet.mjs";

const ticket = {
  data: {
    id: "02",
    key: "export-ui",
    kind: "code",
    touches: ["src/pages/reports/**"],
    blocked_by: ["01"],
    covers: ["Export respects active filters"],
    sources: ["src/pages/reports.tsx"],
  },
  body: "# Export UI\n",
  what: "Add the download button.",
  criteria: [{ text: "Clicking Export downloads a CSV" }],
};

const blocker = {
  data: { id: "01", key: "export-api", kind: "code", touches: ["src/reports/**"] },
  body: "# Export API\n",
  what: "Stream a CSV.",
  criteria: [{ text: "GET /reports/export returns CSV" }],
};

const campaign = {
  slug: "csv-export",
  sections: {
    goal: "Add CSV export",
    "open questions": "- Which filename should the download use?",
  },
};

const state = {
  tickets: {
    "01": {
      stage: "done",
      summary: "Added the export endpoint.",
      actualTouches: ["src/reports/export.ts"],
      checks: [{ name: "npm test -- reports", ok: true }],
      next: "Wire the button to the endpoint.",
      acceptance: [
        {
          criterion: "GET /reports/export returns CSV",
          status: "passed",
          evidence: "ran the endpoint test",
        },
      ],
    },
  },
};

test("a context packet carries evidence, pointers and a do-not-recheck list", () => {
  const packet = buildContextPacket({
    campaign,
    plan: { byId: new Map([["01", blocker], ["02", ticket]]) },
    state,
    ticket,
    decisions: [{ id: "d-1", text: "Reuse the filter object.", cite: "campaign.md § constraints", by: "human" }],
    inbox: [{ status: "open", kind: "question", question: { text: "Which filename?" } }],
  });
  assert.equal(packet.ticket.id, "02");
  assert.equal(packet.dependencies.length, 1);
  assert.equal(packet.dependencies[0].checks[0].name, "npm test -- reports");
  assert.equal(packet.dependencies[0].next, "Wire the button to the endpoint.");
  assert.equal(packet.verified_facts.length, 1);
  assert.equal(packet.verified_facts[0].source, "ticket 01 acceptance");
  assert.equal(packet.commands_run[0].result, "pass");
  assert.ok(packet.do_not_recheck.includes("GET /reports/export returns CSV"));
  assert.ok(packet.do_not_recheck.includes("Reuse the filter object."));
  assert.deepEqual(packet.read_first, ["src/pages/reports.tsx", "src/reports/export.ts"]);
  assert.ok(packet.open_questions.includes("Which filename?"));
  assert.equal(packet.goal, "Add CSV export");
});

test("a packet does not invent a verified fact from a summary alone", () => {
  const packet = buildContextPacket({
    campaign,
    plan: { byId: new Map([["01", blocker]]) },
    state: { tickets: { "01": { stage: "done", summary: "Done.", acceptance: [] } } },
    ticket: { ...ticket, data: { ...ticket.data, blocked_by: ["01"] } },
  });
  assert.equal(packet.verified_facts.length, 0);
  assert.equal(packet.do_not_recheck.length, 0);
});
