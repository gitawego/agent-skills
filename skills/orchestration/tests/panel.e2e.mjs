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
    ws.close();
  } finally {
    browser.kill("SIGKILL");
    panel.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
