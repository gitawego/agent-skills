import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseTicket, validateTickets, touchesOverlap, matchTouches } from "../scripts/lib/plan.mjs";

const ticket = (id, extra = {}, body = {}) => {
  const front = { id, kind: "code", touches: [`src/${id}/**`], ...extra };
  const text = `---\n${Object.entries(front)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n")}\n---\n\n## What to build\n\n${body.what || "Do the thing."}\n\n## Acceptance criteria\n\n${
    body.criteria || "- [ ] It works."
  }\n`;
  const parsed = parseTicket(text, `/tmp/0${id}-t.md`);
  parsed.number = String(id);
  parsed.slug = `0${id}-t`;
  return parsed;
};

test("parses frontmatter, sections and criteria", () => {
  const parsed = ticket("01", { blocked_by: ["02"] });
  assert.equal(parsed.data.id, "01");
  assert.deepEqual(parsed.data.blocked_by, ["02"]);
  assert.equal(parsed.what, "Do the thing.");
  assert.equal(parsed.criteria.length, 1);
  assert.equal(parsed.criteria[0].text, "It works.");
});

test("a valid graph has no errors", () => {
  const { errors, ordered } = validateTickets([ticket("01"), ticket("02", { blocked_by: ["01"] })]);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    ordered.map((t) => t.data.id),
    ["01", "02"],
  );
});

test("a blocking cycle is refused with the path", () => {
  const { errors } = validateTickets([ticket("01", { blocked_by: ["02"] }), ticket("02", { blocked_by: ["01"] })]);
  assert.ok(errors.some((e) => /blocking cycle/.test(e)), errors.join("\n"));
});

test("an unknown blocker is refused", () => {
  const { errors } = validateTickets([ticket("01", { blocked_by: ["09"] })]);
  assert.ok(errors.some((e) => /unknown ticket "09"/.test(e)));
});

test("a duplicate id is refused", () => {
  const { errors } = validateTickets([ticket("01"), ticket("01")]);
  assert.ok(errors.some((e) => /duplicate ticket id/.test(e)));
});

test("an id that disagrees with the filename is refused", () => {
  const wrong = ticket("01");
  wrong.number = "02";
  const { errors } = validateTickets([wrong]);
  assert.ok(errors.some((e) => /does not match the file number/.test(e)));
});

test("a ticket without touches or criteria is refused", () => {
  const { errors } = validateTickets([
    ticket("01", { touches: [] }, { criteria: "none" }),
  ]);
  assert.ok(errors.some((e) => /no touches/.test(e)));
  assert.ok(errors.some((e) => /no acceptance criteria/.test(e)));
});

test("touches overlap is conservative and directional", () => {
  assert.ok(touchesOverlap(["src/api/**"], ["src/api/users.ts"]));
  assert.ok(touchesOverlap(["src/**"], ["src/api"]));
  assert.ok(touchesOverlap(["src/api"], ["src/api/**"]));
  assert.ok(!touchesOverlap(["src/api/**"], ["src/web/**"]));
  assert.ok(!touchesOverlap(["src/a.ts"], ["src/ab.ts"]));
});

test("matchTouches understands globs and dir prefixes", () => {
  assert.ok(matchTouches(["src/*.ts"], "src/a.ts"));
  assert.ok(!matchTouches(["src/*.ts"], "src/deep/a.ts"));
  assert.ok(matchTouches(["docs/**"], "docs/a/b.md"));
  assert.ok(matchTouches([path.normalize("src/api/")], "src/api/x.ts"));
});
