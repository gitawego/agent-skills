import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { sandbox, project, writeConsole, writeCampaign, writeTicket, MODELS } from "./helpers.mjs";
import { startServer } from "../scripts/lib/server.mjs";
import { writeCatalogCache } from "../scripts/lib/catalogs.mjs";
import { createItem } from "../scripts/lib/inbox.mjs";

const BODY = `## Goal\n\nPanel.\n\n## Brief\n\nB.\n\n## Acceptance criteria\n\n- [ ] Shown.\n\n## Constraints\n\nC.\n\n## What to read first\n\n- **Files:** README.md\n`;

function chromePath() {
  return process.env.ORCH_E2E_CHROME || "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function json(url) {
  const res = await fetch(url);
  return res.json();
}

test("the panel renders adapter controls in a browser", { skip: !chromePath() }, async () => {
  const box = sandbox();
  const dir = project(path.join(box, "repo"));
  writeConsole();
  writeCampaign(
    dir,
    "demo",
    {
      campaign: "demo",
      stage: "awaiting_approval",
      autonomy: "supervised",
      plan_gate: "human",
      landing: "branch",
      base: "main",
      checks: [],
      budget: { tokens: null, dollars: null },
      max_autoship_lines: 200,
      kinds: { code: { models: [{ model: MODELS.strong, thinking: "high" }] } },
    },
    BODY,
  );
  writeTicket(
    dir,
    "demo",
    "01-work.md",
    { id: "01", kind: "code", touches: ["src/**"], sources: ["README.md"] },
    "## What to build\n\nIt.\n\n## Acceptance criteria\n\n- [ ] Works.",
  );
  createItem(dir, "demo", {
    kind: "review",
    title: "Campaign ready: demo",
    brief: "12 added, 2 removed. The branch is ready.",
  });
  writeCatalogCache("agy-acp", [
    {
      adapter: "agy-acp",
      provider: "antigravity",
      model: "gemini-4-argon",
      label: "Gemini 4 Argon",
      context: null,
      maxOut: null,
      thinking: true,
      thinkingLevels: ["low", "medium", "high"],
      images: true,
      price: null,
      billing: "subscription",
      plan: "subscription",
      included: true,
    },
  ]);

  const panel = await startServer({ roots: [dir], port: 0 });
  const port = 9300 + Math.floor(Math.random() * 400);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orch-chrome-"));
  const browser = spawn(
    chromePath(),
    ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-background-networking", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"],
    { stdio: "ignore" },
  );

  try {
    let pages = null;
    for (let i = 0; i < 40; i++) {
      try {
        pages = await json(`http://127.0.0.1:${port}/json`);
        if (pages?.length) break;
      } catch {
        /* not up yet */
      }
      await sleep(250);
    }
    assert.ok(pages?.length, "the browser exposed a devtools page");

    const ws = new WebSocket(pages.find((page) => page.type === "page").webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    };
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        const msgId = ++id;
        pending.set(msgId, resolve);
        ws.send(JSON.stringify({ id: msgId, method, params }));
      });
    await new Promise((resolve) => (ws.onopen = resolve));
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Page.navigate", { url: `http://127.0.0.1:${panel.port}/?token=${panel.token}#settings` });
    await sleep(2500);
    const result = await send("Runtime.evaluate", {
      expression: `JSON.stringify({ adapters: document.querySelectorAll('[data-role="adapter"]').length, spend: document.querySelector('[name="spend"]')?.value, sandbox: document.querySelector('[name="sandbox"]')?.value, openRepo: Boolean(document.getElementById("browse-repo")), search: Boolean(document.querySelector('[data-role="model-search"]')), title: document.body.innerText.includes("Settings") })`,
      returnByValue: true,
    });
    const page = JSON.parse(result.result.result.value);
    assert.ok(page.adapters >= 1, "an adapter selector is rendered");
    assert.equal(page.title, true, "the settings screen is visible");
    assert.equal(page.openRepo, true, "the open-repository button is rendered");
    assert.equal(page.search, true, "the searchable model picker is rendered");
    assert.match(page.spend, /metered-ok|subscription-only/);
    assert.match(page.sandbox, /auto|bwrap|none/);
    const search = await send("Runtime.evaluate", {
      expression: `(() => {
        const input = document.querySelector('[data-role="model-search"]');
        input.value = "gemini";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return document.querySelector(".model-suggest")?.textContent || "";
      })()`,
      returnByValue: true,
    });
    assert.match(search.result.result.value, /gemini/i, "search filters the model list");
    await sleep(16000);
    const stillOpen = await send("Runtime.evaluate", {
      expression: `JSON.stringify({ open: !document.querySelector(".model-suggest").hidden, text: document.querySelector(".model-suggest").textContent })`,
      returnByValue: true,
    });
    const suggestion = JSON.parse(stillOpen.result.result.value);
    assert.equal(suggestion.open, true, "the suggestion list survives the 15s refresh");
    assert.match(suggestion.text, /gemini/i);

    await send("Runtime.evaluate", { expression: `document.getElementById("browse-repo").click()`, returnByValue: true });
    await sleep(1200);
    const folder = await send("Runtime.evaluate", {
      expression: `JSON.stringify({ open: !document.getElementById("folder-picker").hidden, path: document.getElementById("browse-path").textContent, entries: document.querySelectorAll("#browse-list button").length })`,
      returnByValue: true,
    });
    const picker = JSON.parse(folder.result.result.value);
    assert.equal(picker.open, true, "the folder picker opens");
    assert.ok(picker.path.length > 0, "the picker shows a path");
    assert.ok(picker.entries > 0, "the picker lists directories");

    await send("Page.navigate", { url: `http://127.0.0.1:${panel.port}/?token=${panel.token}` });
    await sleep(1500);
    const fleet = await send("Runtime.evaluate", {
      expression: `JSON.stringify({
        fleet: Boolean(document.querySelector(".fleet-table")),
        rows: document.querySelectorAll(".fleet-row").length,
        tabs: [...document.querySelectorAll(".fleet-tabs button")].map((b) => b.textContent.trim()),
        dispatch: document.getElementById("dispatch-pill")?.textContent,
        quotas: document.querySelector(".quota-strip")?.textContent || "",
        search: Boolean(document.querySelector('[data-role="fleet-search"]')),
      })`,
      returnByValue: true,
    });
    const fleetPage = JSON.parse(fleet.result.result.value);
    assert.equal(fleetPage.fleet, true, "Fleet is the default surface");
    assert.ok(fleetPage.rows >= 2, "the fleet shows a ticket and an acceptance row");
    assert.ok(fleetPage.tabs.some((tab) => /Acceptance/.test(tab)), "status tabs include acceptance");
    assert.match(fleetPage.dispatch, /Dispatch auto/);
    assert.match(fleetPage.quotas, /none configured/);
    assert.equal(fleetPage.search, true, "the fleet has a search field");

    const authority = await send("Runtime.evaluate", {
      expression: `JSON.stringify({
        newCampaign: Boolean(document.querySelector('[data-act="new-campaign"]')),
        decisionInputs: document.querySelectorAll('[data-answer], textarea[data-accept-note]').length,
      })`,
      returnByValue: true,
    });
    const authoring = JSON.parse(authority.result.result.value);
    assert.equal(authoring.newCampaign, false, "campaigns start in the agent");
    assert.equal(authoring.decisionInputs, 0, "the panel does not host decisions");

    const filtered = await send("Runtime.evaluate", {
      expression: `(() => {
        const input = document.querySelector('[data-role="fleet-search"]');
        input.value = "no-such-work";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        const empty = document.querySelector(".fleet-empty")?.textContent || "";
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return empty;
      })()`,
      returnByValue: true,
    });
    assert.match(filtered.result.result.value, /No rows match/, "search filters the fleet without a reload");

    const acceptance = await send("Runtime.evaluate", {
      expression: `(() => {
        document.querySelector('[data-act="fleet-status"][data-status="acceptance"]').click();
        return JSON.stringify({ rows: document.querySelectorAll(".fleet-row").length, queue: document.querySelector(".fleet-row .queue")?.textContent || "" });
      })()`,
      returnByValue: true,
    });
    const acceptanceTab = JSON.parse(acceptance.result.result.value);
    assert.equal(acceptanceTab.rows, 1, "the acceptance tab keeps only deliveries");
    assert.match(acceptanceTab.queue, /waiting/);

    const dispatch = await send("Runtime.evaluate", {
      expression: `(() => {
        document.getElementById("dispatch-pill").click();
        const open = !document.getElementById("dispatch-modal").hidden;
        document.getElementById("dispatch-apply").click();
        return JSON.stringify({ open, stillOpen: !document.getElementById("dispatch-modal").hidden, title: document.getElementById("dispatch-title").textContent });
      })()`,
      returnByValue: true,
    });
    const dispatchModal = JSON.parse(dispatch.result.result.value);
    assert.equal(dispatchModal.open, true, "the dispatch switch opens a reason dialog");
    assert.equal(dispatchModal.stillOpen, true, "a pause without a reason is refused");
    assert.match(dispatchModal.title, /Pause dispatch/);

    await send("Page.navigate", { url: `http://127.0.0.1:${panel.port}/?token=${panel.token}#acceptance` });
    await sleep(900);
    const acceptView = await send("Runtime.evaluate", {
      expression: `JSON.stringify({
        cards: document.querySelectorAll(".acceptance-card").length,
        commands: document.querySelectorAll(".acceptance-card .command-row").length,
        approve: Boolean(document.querySelector('[data-act="approve-item"]')),
        title: document.body.innerText.includes("Acceptance"),
      })`,
      returnByValue: true,
    });
    const acceptPage = JSON.parse(acceptView.result.result.value);
    assert.equal(acceptPage.cards, 1, "the acceptance queue lists the delivery");
    assert.ok(acceptPage.commands >= 2, "approve and send-back hand off to the agent");
    assert.equal(acceptPage.approve, true, "a binary approval is available in the browser");
    assert.equal(acceptPage.title, true);

    await send("Page.navigate", { url: `http://127.0.0.1:${panel.port}/?token=${panel.token}#settings` });
    await sleep(900);
    const quota = await send("Runtime.evaluate", {
      expression: `(() => {
        const before = document.querySelectorAll(".quota-row").length;
        document.querySelector('[data-act="quota-add"]').click();
        const after = document.querySelectorAll(".quota-row").length;
        return JSON.stringify({ before, after, editor: Boolean(document.querySelector(".quota-editor")) });
      })()`,
      returnByValue: true,
    });
    const quotaEditor = JSON.parse(quota.result.result.value);
    assert.equal(quotaEditor.editor, true, "settings renders the quota editor");
    assert.equal(quotaEditor.after, quotaEditor.before + 1, "a quota window can be added");

    await send("Page.navigate", { url: `http://127.0.0.1:${panel.port}/?token=${panel.token}#campaign/demo` });
    await sleep(900);
    const overview = await send("Runtime.evaluate", {
      expression: `JSON.stringify({
        h1: document.querySelector("h1")?.textContent || "",
        tabs: [...document.querySelectorAll(".campaign-subnav button")].map((b) => b.textContent.trim()),
        briefInput: document.querySelectorAll('textarea[name="brief"]').length,
        chains: document.body.innerText.includes("Model chains"),
        next: document.querySelector(".next-action")?.textContent || "",
        briefing: Boolean(document.querySelector(".briefing-details")),
        briefingOpen: Boolean(document.querySelector(".briefing-details")?.open),
      })`,
      returnByValue: true,
    });
    const overviewPage = JSON.parse(overview.result.result.value);
    assert.equal(overviewPage.h1, "Panel.", "the goal is the page title");
    assert.deepEqual(overviewPage.tabs.slice(0, 3), ["Overview", "Tickets 1", "Configure"], "the campaign has sections");
    assert.equal(overviewPage.briefInput, 0, "the brief is read-only");
    assert.equal(overviewPage.chains, false, "chains are not on the overview");
    assert.equal(overviewPage.briefing, true, "the briefing is a disclosure");
    assert.equal(overviewPage.briefingOpen, false, "healthy briefing is collapsed");
    assert.match(overviewPage.next, /Approve the plan|delivery is waiting|draft plan/, "the next action names the agent step");

    const evidenceStateDir = path.join(dir, ".orchestration", "campaigns", "demo");
    fs.mkdirSync(evidenceStateDir, { recursive: true });
    fs.writeFileSync(
      path.join(evidenceStateDir, "state.json"),
      JSON.stringify({
        campaign: "demo",
        stage: "awaiting_approval",
        tickets: {
          "01": {
            stage: "done",
            acceptance: [{ criterion: "Works.", status: "passed", evidence: "ran the fixture check" }],
            findings: [
              {
                id: "F1",
                severity: "blocker",
                file: "src/cli.ts",
                line: 42,
                problem: "argv is sliced twice",
                requiredFix: "slice argv once",
              },
            ],
            reviewedHead: "abc12345deadbeef",
            reviewedBase: "base12345",
            reviewModel: MODELS.backup,
            workerModel: MODELS.strong,
            reviewSameAsWorker: false,
            gateCycles: 1,
          },
        },
        runs: {},
        slots: {},
        spend: { tokens: 0, dollars: 0, byModel: {} },
      }),
    );
    await send("Page.navigate", { url: `http://127.0.0.1:${panel.port}/?token=${panel.token}#campaign/demo/tickets` });
    await sleep(600);
    const tickets = await send("Runtime.evaluate", {
      expression: `JSON.stringify({
        rows: document.querySelectorAll(".ticket-table tbody tr[data-act]").length,
        newTicket: Boolean(document.querySelector('[data-act="add-ticket"]')),
        title: document.body.innerText.includes("Tickets"),
      })`,
      returnByValue: true,
    });
    const ticketsPage = JSON.parse(tickets.result.result.value);
    assert.equal(ticketsPage.rows, 1, "the ticket manifest lists the ticket");
    assert.equal(ticketsPage.newTicket, true, "the manual ticket form is available in the Tickets section");
    assert.equal(ticketsPage.title, true);

    const drawer = await send("Runtime.evaluate", {
      expression: `(() => {
        document.querySelector(".ticket-table tbody tr[data-act]")?.click();
        return JSON.stringify({
          open: !document.getElementById("drawer").hidden,
          edit: Boolean(document.querySelector('[name="e_what"]')),
          commands: document.querySelectorAll("#drawer .command-row").length,
          title: document.querySelector("#drawer h1")?.textContent || "",
          evidence: document.querySelector("#drawer .evidence")?.textContent || "",
        });
      })()`,
      returnByValue: true,
    });
    const drawerPage = JSON.parse(drawer.result.result.value);
    assert.equal(drawerPage.open, true, "a ticket opens in the drawer");
    assert.equal(drawerPage.edit, false, "the ticket is not editable in the panel");
    assert.ok(drawerPage.commands >= 1, "the drawer hands edits back to the agent");
    assert.match(drawerPage.title, /01/);
    assert.match(drawerPage.evidence, /ran the fixture check/, "acceptance evidence is in the drawer");
    assert.match(drawerPage.evidence, /argv is sliced twice/, "findings are in the drawer");
    assert.match(drawerPage.evidence, /abc12345/, "the reviewed revision is in the drawer");
    assert.match(drawerPage.evidence, new RegExp(MODELS.backup.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const board = await send("Runtime.evaluate", {
      expression: `(() => {
        document.querySelector('[data-act="close-drawer"]')?.click();
        document.querySelector('[data-act="ticket-view"][data-view="board"]')?.click();
        return JSON.stringify({ board: Boolean(document.querySelector(".ticket-board")), strips: document.querySelectorAll(".ticket-board .strip").length });
      })()`,
      returnByValue: true,
    });
    const boardPage = JSON.parse(board.result.result.value);
    assert.equal(boardPage.board, true, "the ticket board renders");
    assert.equal(boardPage.strips, 1, "the board has the ticket strip");

    const ticketSearch = await send("Runtime.evaluate", {
      expression: `(() => {
        document.querySelector('[data-act="ticket-view"][data-view="list"]')?.click();
        const input = document.querySelector('[data-role="ticket-search"]');
        input.value = "no-such-ticket";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return document.getElementById("ticket-list")?.textContent || "";
      })()`,
      returnByValue: true,
    });
    assert.match(ticketSearch.result.result.value, /No tickets match/, "ticket search filters without a reload");

    const stateDir = path.join(dir, ".orchestration", "campaigns", "demo");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "plan.applied.json"),
      JSON.stringify({
        version: 1,
        hash: "abc123def456",
        appliedAt: "2026-11-10T20:00:00Z",
        tickets: [{ id: "01", key: "work", title: "Work", kind: "code" }],
        assumptions: ["Plain files only."],
        openQuestions: [],
      }),
    );
    fs.writeFileSync(
      path.join(stateDir, "plan.yml"),
      `version: 1
goal: Panel.
brief: B.
criteria:
  - Shown.
constraints: C.
assumptions:
  - Plain files only.
open_questions:
  - Which storage format?
reading: README.md
tickets:
  - key: work
    title: Work
    kind: code
    touches: [src/**]
    what: It.
    accept: [Works.]
    sources: [README.md]
`,
    );

    await send("Page.navigate", { url: `http://127.0.0.1:${panel.port}/?token=${panel.token}#campaign/demo` });
    await sleep(800);
    const draftView = await send("Runtime.evaluate", {
      expression: `JSON.stringify({
        draft: document.querySelector(".draft-plan")?.textContent || "",
        next: document.querySelector(".next-action")?.textContent || "",
        assumptions: document.getElementById("app")?.textContent.toLowerCase().includes("assumptions"),
      })`,
      returnByValue: true,
    });
    const draftPage = JSON.parse(draftView.result.result.value);
    assert.match(draftPage.draft, /Draft plan|draft plan/);
    assert.match(draftPage.draft, /1 ticket/);
    assert.match(draftPage.next, /draft plan|delivery is waiting/i, "the next action stays actionable");
    assert.equal(draftPage.assumptions, true);
    assert.doesNotMatch(draftPage.draft, /Approve and run/, "an open-question draft has no approve action");
    assert.match(draftPage.draft, /open question|not ready/i, "the draft names why it cannot be approved");

    fs.writeFileSync(
      path.join(stateDir, "plan.yml"),
      `version: 1
goal: Panel.
brief: B.
criteria:
  - Shown.
constraints: C.
assumptions:
  - Plain files only.
open_questions: []
reading: README.md
tickets:
  - key: work
    title: Work
    kind: code
    touches: [src/**]
    what: It.
    accept: [Works.]
    covers: [Shown.]
    sources: [README.md]
`,
    );
    await send("Page.navigate", { url: `http://127.0.0.1:${panel.port}/?token=${panel.token}#campaign/demo` });
    await sleep(800);
    const cleanDraftView = await send("Runtime.evaluate", {
      expression: `JSON.stringify({
        draft: document.querySelector(".draft-plan")?.textContent || "",
        approve: Boolean(document.querySelector('[data-act="approve-campaign"]')),
        coverage: document.querySelector(".draft-plan .coverage-table")?.textContent || "",
      })`,
      returnByValue: true,
    });
    const cleanDraft = JSON.parse(cleanDraftView.result.result.value);
    assert.equal(cleanDraft.approve, true, "a clean draft offers one approve action");
    assert.match(cleanDraft.draft, /Approve and run/);
    assert.match(cleanDraft.coverage, /Shown\./, "the draft shows its coverage matrix");

    await send("Page.navigate", { url: `http://127.0.0.1:${panel.port}/?token=${panel.token}#campaign/demo/history` });
    await sleep(700);
    const historyPlan = await send("Runtime.evaluate", {
      expression: `JSON.stringify({
        plan: document.querySelector(".settings-block")?.textContent || "",
        hash: document.body.innerText.includes("abc123def456"),
        attention: document.body.textContent.includes("Attention"),
      })`,
      returnByValue: true,
    });
    const historyPage = JSON.parse(historyPlan.result.result.value);
    assert.match(historyPage.plan, /1 ticket applied/);
    assert.equal(historyPage.hash, true, "the applied plan hash is visible");
    assert.equal(historyPage.attention, true, "History shows the attention metric");

    fs.unlinkSync(path.join(stateDir, "plan.applied.json"));
    await send("Page.navigate", { url: `http://127.0.0.1:${panel.port}/?token=${panel.token}#campaign/demo/history` });
    await sleep(700);
    const derived = await send("Runtime.evaluate", {
      expression: `JSON.stringify({ plan: document.querySelector(".settings-block")?.textContent || "" })`,
      returnByValue: true,
    });
    assert.match(JSON.parse(derived.result.result.value).plan, /derived from tickets/);

    await send("Page.navigate", { url: `http://127.0.0.1:${panel.port}/?token=${panel.token}#campaign/demo/tickets` });
    await sleep(600);
    const sources = await send("Runtime.evaluate", {
      expression: `(() => {
        document.querySelector(".ticket-table tbody tr[data-act]")?.click();
        return document.querySelector("#drawer")?.innerText || "";
      })()`,
      returnByValue: true,
    });
    assert.match(sources.result.result.value, /SOURCES|Sources/);
    assert.match(sources.result.result.value, /README\.md/);
    await send("Runtime.evaluate", { expression: `document.querySelector('[data-act="close-drawer"]')?.click()` });

    await send("Page.navigate", { url: `http://127.0.0.1:${panel.port}/?token=${panel.token}#board` });
    await sleep(700);
    const legacyBoard = await send("Runtime.evaluate", {
      expression: `JSON.stringify({ hash: location.hash, board: Boolean(document.querySelector(".ticket-board")) })`,
      returnByValue: true,
    });
    const legacyPage = JSON.parse(legacyBoard.result.result.value);
    assert.equal(legacyPage.board, true, "an old #board link lands on the ticket board");
    assert.match(legacyPage.hash, /#campaign\/demo\/tickets/);

    await send("Page.navigate", { url: `http://127.0.0.1:${panel.port}/?token=${panel.token}#campaign` });
    await sleep(700);
    const legacyCampaign = await send("Runtime.evaluate", {
      expression: `JSON.stringify({ hash: location.hash, tabs: document.querySelectorAll(".campaign-subnav button").length })`,
      returnByValue: true,
    });
    const legacyCampaignPage = JSON.parse(legacyCampaign.result.result.value);
    assert.match(legacyCampaignPage.hash, /#campaign\/demo/);
    assert.equal(legacyCampaignPage.tabs, 4, "an old #campaign link lands on the campaign overview");

    await send("Page.navigate", { url: `http://127.0.0.1:${panel.port}/?token=${panel.token}#campaign/demo/configure` });
    await sleep(600);
    const configure = await send("Runtime.evaluate", {
      expression: `(async () => {
        const chains = document.body.innerText.includes("Model chains");
        const autoship = document.querySelector('input[name="max_autoship_lines"]');
        autoship.value = "321";
        autoship.dispatchEvent(new Event("input", { bubbles: true }));
        await load({ quiet: true });
        return JSON.stringify({
          chains,
          value: document.querySelector('input[name="max_autoship_lines"]')?.value || "",
          save: Boolean(document.querySelector('[data-act="save-campaign"]')),
          advanced: Boolean(document.querySelector("#app .advanced")),
          advancedOpen: Boolean(document.querySelector("#app .advanced")?.open),
        });
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    const configurePage = JSON.parse(configure.result.result.value);
    assert.equal(configurePage.chains, true, "chains live in Configure");
    assert.equal(configurePage.value, "321", "an unsaved config edit survives a background refresh");
    assert.equal(configurePage.save, true, "configuration has one explicit save");
    assert.equal(configurePage.advanced, true, "advanced settings are disclosed");
    assert.equal(configurePage.advancedOpen, false, "advanced settings start collapsed");

    const stateFile = path.join(stateDir, "state.json");
    const stateBase = {
      campaign: "demo",
      stage: "delivered",
      reason: null,
      tickets: {},
      runs: {},
      slots: {},
      spend: { tokens: 0, dollars: 0, byModel: {} },
      delivery: { mode: "manual", branch: "orch/demo/integration", detail: "Ready to review", stats: { added: 1, removed: 0, lines: 1 } },
    };
    fs.writeFileSync(stateFile, JSON.stringify(stateBase));
    await send("Page.navigate", { url: `http://127.0.0.1:${panel.port}/?token=${panel.token}#campaign/demo/history` });
    await sleep(700);
    const manualDelivery = await send("Runtime.evaluate", {
      expression: `document.body.innerText`,
      returnByValue: true,
    });
    const manualText = manualDelivery.result.result.value;
    assert.match(manualText, /orch\/demo\/integration/);
    assert.match(manualText, /Open a PR/);
    assert.match(manualText, /orchestrate acceptance/);

    stateBase.delivery = { mode: "merged", branch: "orch/demo/integration", detail: "Merged", stats: { added: 1, removed: 0, lines: 1 } };
    fs.writeFileSync(stateFile, JSON.stringify(stateBase));
    await send("Page.navigate", { url: `http://127.0.0.1:${panel.port}/?token=${panel.token}#campaign/demo/history` });
    await sleep(700);
    const mergedDelivery = await send("Runtime.evaluate", {
      expression: `document.body.innerText`,
      returnByValue: true,
    });
    const mergedText = mergedDelivery.result.result.value;
    assert.match(mergedText, /Preview cleanup/);
    assert.match(mergedText, /Remove branches and worktree/);
    assert.match(mergedText, /orchestrate cleanup demo --dry-run/);
    ws.close();
  } finally {
    browser.kill("SIGKILL");
    panel.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test("the panel filters all views by selected campaign", { skip: !chromePath() }, async () => {
  const box = sandbox();
  const dir = project(path.join(box, "repo"));
  writeConsole();

  writeCampaign(
    dir,
    "alpha",
    {
      campaign: "alpha",
      stage: "awaiting_approval",
      autonomy: "supervised",
      plan_gate: "human",
      landing: "branch",
      base: "main",
      checks: [],
      budget: { tokens: null, dollars: null },
      max_autoship_lines: 200,
      kinds: { code: { models: [{ model: MODELS.strong, thinking: "high" }] } },
    },
    BODY,
  );
  writeTicket(dir, "alpha", "01-first.md", { id: "01", kind: "code", touches: ["src/a/**"] }, "## What to build\n\nA.\n\n## Acceptance criteria\n\n- [ ] Works.");
  writeTicket(dir, "alpha", "02-second.md", { id: "02", kind: "code", touches: ["src/b/**"] }, "## What to build\n\nB.\n\n## Acceptance criteria\n\n- [ ] Works.");
  createItem(dir, "alpha", {
    kind: "review",
    title: "Campaign ready: alpha",
    brief: "Alpha delivery waiting for review.",
  });

  writeCampaign(
    dir,
    "beta",
    {
      campaign: "beta",
      stage: "running",
      autonomy: "trusted",
      plan_gate: "auto",
      landing: "branch",
      base: "main",
      checks: [],
      budget: { tokens: null, dollars: null },
      max_autoship_lines: 200,
      kinds: { code: { models: [{ model: MODELS.strong, thinking: "high" }] } },
    },
    BODY,
  );
  writeTicket(dir, "beta", "01-work.md", { id: "01", kind: "code", touches: ["src/c/**"] }, "## What to build\n\nC.\n\n## Acceptance criteria\n\n- [ ] Works.");

  const panel = await startServer({ roots: [dir], port: 0 });
  const port = 9400 + Math.floor(Math.random() * 400);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orch-chrome-filter-"));
  const browser = spawn(
    chromePath(),
    ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-background-networking", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"],
    { stdio: "ignore" },
  );

  try {
    let pages = null;
    for (let i = 0; i < 40; i++) {
      try {
        pages = await json(`http://127.0.0.1:${port}/json`);
        if (pages?.length) break;
      } catch {
        /* not up yet */
      }
      await sleep(250);
    }
    assert.ok(pages?.length, "the browser exposed a devtools page");

    const ws = new WebSocket(pages.find((page) => page.type === "page").webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    };
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        const msgId = ++id;
        pending.set(msgId, resolve);
        ws.send(JSON.stringify({ id: msgId, method, params }));
      });
    await new Promise((resolve) => (ws.onopen = resolve));
    await send("Runtime.enable");
    await send("Page.enable");

    // 1. Initial Fleet load (All campaigns)
    await send("Page.navigate", { url: `http://127.0.0.1:${panel.port}/?token=${panel.token}#fleet` });
    await sleep(2000);

    const initial = await send("Runtime.evaluate", {
      expression: `JSON.stringify({
        rows: document.querySelectorAll(".fleet-row").length,
        summary: document.getElementById("fleet-summary")?.textContent || "",
        crumbs: document.getElementById("crumbs")?.textContent || "",
        selectVal: document.querySelector('[data-role="fleet-campaign"]')?.value || "",
        allRailCurrent: document.querySelector('.campaign-row[data-campaign=""]')?.getAttribute("aria-current"),
      })`,
      returnByValue: true,
    });
    const initPage = JSON.parse(initial.result.result.value);
    assert.equal(initPage.rows, 4, "all 4 rows shown across both campaigns");
    assert.match(initPage.crumbs, /2 campaigns.*4 rows/);
    assert.equal(initPage.selectVal, "");
    assert.equal(initPage.allRailCurrent, "true");

    // 2. Select beta from the rail
    await send("Runtime.evaluate", {
      expression: `(() => {
        document.querySelector('[data-act="select-campaign"][data-campaign="beta"]').click();
      })()`,
    });
    await sleep(500);

    const betaFleet = await send("Runtime.evaluate", {
      expression: `JSON.stringify({
        rows: document.querySelectorAll(".fleet-row").length,
        summary: document.getElementById("fleet-summary")?.textContent || "",
        crumbs: document.getElementById("crumbs")?.textContent || "",
        selectVal: document.querySelector('[data-role="fleet-campaign"]')?.value || "",
        betaRailCurrent: document.querySelector('.campaign-row[data-campaign="beta"]')?.getAttribute("aria-current"),
        allRailCurrent: document.querySelector('.campaign-row[data-campaign=""]')?.getAttribute("aria-current"),
      })`,
      returnByValue: true,
    });
    const betaPage = JSON.parse(betaFleet.result.result.value);
    assert.equal(betaPage.rows, 1, "only beta's 1 row is displayed");
    assert.match(betaPage.crumbs, /beta.*1 row/);
    assert.equal(betaPage.selectVal, "beta");
    assert.equal(betaPage.betaRailCurrent, "true");
    assert.equal(betaPage.allRailCurrent, "false");

    // 3. Switch dropdown filter to alpha
    await send("Runtime.evaluate", {
      expression: `(() => {
        const sel = document.querySelector('[data-role="fleet-campaign"]');
        sel.value = "alpha";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      })()`,
    });
    await sleep(500);

    const alphaFleet = await send("Runtime.evaluate", {
      expression: `JSON.stringify({
        rows: document.querySelectorAll(".fleet-row").length,
        crumbs: document.getElementById("crumbs")?.textContent || "",
        alphaRailCurrent: document.querySelector('.campaign-row[data-campaign="alpha"]')?.getAttribute("aria-current"),
        acceptCount: document.getElementById("accept-count")?.textContent || "",
      })`,
      returnByValue: true,
    });
    const alphaPage = JSON.parse(alphaFleet.result.result.value);
    assert.equal(alphaPage.rows, 3, "alpha's 3 rows (2 tickets + 1 acceptance) displayed");
    assert.match(alphaPage.crumbs, /alpha.*3 rows/);
    assert.equal(alphaPage.alphaRailCurrent, "true");
    assert.equal(alphaPage.acceptCount, "1", "nav badge reflects alpha's 1 acceptance item");

    // 4. Navigate to Acceptance tab while alpha is selected
    await send("Runtime.evaluate", {
      expression: `document.querySelector('button[data-view="acceptance"]').click()`,
    });
    await sleep(500);

    const acceptAlpha = await send("Runtime.evaluate", {
      expression: `JSON.stringify({
        cards: document.querySelectorAll(".acceptance-card").length,
        crumbs: document.getElementById("crumbs")?.textContent || "",
      })`,
      returnByValue: true,
    });
    const acceptAlphaPage = JSON.parse(acceptAlpha.result.result.value);
    assert.equal(acceptAlphaPage.cards, 1, "alpha delivery card visible");
    assert.match(acceptAlphaPage.crumbs, /Acceptance.*alpha.*1 waiting/);

    // 5. Select beta while in Acceptance view
    await send("Runtime.evaluate", {
      expression: `document.querySelector('[data-act="select-campaign"][data-campaign="beta"]').click()`,
    });
    await sleep(500);

    const acceptBeta = await send("Runtime.evaluate", {
      expression: `JSON.stringify({
        cards: document.querySelectorAll(".acceptance-card").length,
        empty: Boolean(document.querySelector(".empty")),
        crumbs: document.getElementById("crumbs")?.textContent || "",
      })`,
      returnByValue: true,
    });
    const acceptBetaPage = JSON.parse(acceptBeta.result.result.value);
    assert.equal(acceptBetaPage.cards, 0, "beta has no delivery cards");
    assert.equal(acceptBetaPage.empty, true, "shows empty acceptance view");
    assert.match(acceptBetaPage.crumbs, /Acceptance.*beta.*0 waiting/);

    // 6. Click All campaigns from the rail while on Fleet
    await send("Runtime.evaluate", {
      expression: `(() => {
        document.querySelector('button[data-view="fleet"]').click();
        document.querySelector('.campaign-row[data-campaign=""]').click();
      })()`,
    });
    await sleep(500);

    const resetAll = await send("Runtime.evaluate", {
      expression: `JSON.stringify({
        rows: document.querySelectorAll(".fleet-row").length,
        crumbs: document.getElementById("crumbs")?.textContent || "",
        allRailCurrent: document.querySelector('.campaign-row[data-campaign=""]')?.getAttribute("aria-current"),
      })`,
      returnByValue: true,
    });
    const resetPage = JSON.parse(resetAll.result.result.value);
    assert.equal(resetPage.rows, 4, "all 4 rows restored");
    assert.match(resetPage.crumbs, /2 campaigns.*4 rows/);
    assert.equal(resetPage.allRailCurrent, "true");

    ws.close();
  } finally {
    browser.kill("SIGKILL");
    panel.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
