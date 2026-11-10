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
  writeTicket(dir, "demo", "01-work.md", { id: "01", kind: "code", touches: ["src/**"] }, "## What to build\n\nIt.\n\n## Acceptance criteria\n\n- [ ] Works.");
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

    const compose = await send("Runtime.evaluate", {
      expression: `(async () => {
        document.querySelector('[data-act="new-campaign"]').click();
        await new Promise((resolve) => setTimeout(resolve, 60));
        const goal = document.querySelector("#nc-goal");
        goal.value = "Survives a background refresh";
        goal.dispatchEvent(new Event("input", { bubbles: true }));
        goal.blur();
        await load({ quiet: true });
        const result = {
          form: Boolean(document.querySelector("#nc-goal")),
          value: document.querySelector("#nc-goal")?.value || "",
          crumb: document.querySelector("#crumbs")?.textContent || "",
        };
        document.querySelector('[data-act="close-compose"]')?.click();
        return JSON.stringify(result);
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    const composePage = JSON.parse(compose.result.result.value);
    assert.equal(composePage.form, true, "the new-campaign form survives a background refresh");
    assert.equal(composePage.value, "Survives a background refresh", "typed values are not dropped");
    assert.match(composePage.crumb, /New campaign/);

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
        bulk: document.querySelector('[data-act="approve-selected"]')?.disabled,
        title: document.body.innerText.includes("Acceptance"),
      })`,
      returnByValue: true,
    });
    const acceptPage = JSON.parse(acceptView.result.result.value);
    assert.equal(acceptPage.cards, 1, "the acceptance queue lists the delivery");
    assert.equal(acceptPage.bulk, true, "bulk approval is disabled until a delivery is selected");
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

    await send("Page.navigate", { url: `http://127.0.0.1:${panel.port}/?token=${panel.token}#campaign` });
    await sleep(900);
    const campaignEdit = await send("Runtime.evaluate", {
      expression: `(async () => {
        const brief = document.querySelector('textarea[name="brief"]');
        brief.value = "Unsaved brief survives";
        brief.dispatchEvent(new Event("input", { bubbles: true }));
        brief.blur();
        await load({ quiet: true });
        return JSON.stringify({ value: document.querySelector('textarea[name="brief"]')?.value || "", view: document.body.innerText.includes("Model chains") });
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    const campaignPage = JSON.parse(campaignEdit.result.result.value);
    assert.equal(campaignPage.value, "Unsaved brief survives", "an unsaved campaign edit survives a background refresh");
    assert.equal(campaignPage.view, true, "the campaign screen is still visible");
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
