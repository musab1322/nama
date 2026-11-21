import { test } from "node:test";
import assert from "node:assert/strict";
import { accountGuide, closedTestProgress } from "@banna/policy/account-guide";

test("guides: D-U-N-S only for organizations, closed test only for personal Google accounts", () => {
  const ids = (g: ReturnType<typeof accountGuide>) => g.steps.map((s) => s.id);
  assert.ok(ids(accountGuide("apple", "organization")).includes("duns"));
  assert.ok(!ids(accountGuide("apple", "individual")).includes("duns"));
  assert.ok(ids(accountGuide("google", "individual")).includes("closed_test"));
  assert.ok(!ids(accountGuide("google", "organization")).includes("closed_test"));
  for (const g of [accountGuide("apple", "individual"), accountGuide("google", "organization")]) {
    assert.ok(g.steps.every((s) => s.ar.length > 10 && s.en.length > 10));
    assert.ok(g.steps.every((s) => !s.url || s.url.startsWith("https://")));
  }
});

test("closed test: 14 days from the first closed release", () => {
  assert.deepEqual(closedTestProgress(null), { started: false, daysDone: 0, daysLeft: 14, canApply: false });
  const start = new Date("2026-11-01T10:00:00Z");
  assert.equal(closedTestProgress(start, new Date("2026-11-08T10:00:00Z")).daysLeft, 7);
  assert.equal(closedTestProgress(start, new Date("2026-11-15T09:00:00Z")).canApply, false);
  assert.equal(closedTestProgress(start, new Date("2026-11-15T10:00:00Z")).canApply, true);
});
