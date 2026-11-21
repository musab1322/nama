import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewSpec } from "@banna/policy/review";
import { flowerShop } from "./fixtures/flower-shop.spec";

test("review: a valid spec with no blocking finding is approvable", () => {
  const r = reviewSpec(structuredClone(flowerShop), { organization: null });
  assert.ok(r.spec);
  assert.deepEqual(r.issues, []);
  assert.equal(r.approvable, true);
});

test("review: malformed content is never approvable and skips policy", () => {
  const r = reviewSpec({ goal: "x" }, { organization: null });
  assert.equal(r.spec, null);
  assert.ok(r.issues.length > 0 && r.issues.every((i) => i.code === "shape"));
  assert.deepEqual(r.findings, []);
  assert.equal(r.approvable, false);
});

test("review: semantic issues block approval", () => {
  const spec = structuredClone(flowerShop);
  spec.entities[0]!.name = "users"; // reserved
  const r = reviewSpec(spec, { organization: null });
  assert.ok(r.spec);
  assert.ok(r.issues.some((i) => i.code === "reserved"));
  assert.equal(r.approvable, false);
});

test("review: donations without a verified charity block approval", () => {
  const spec = { ...structuredClone(flowerShop), category: "charity" as const, payments: { mode: "donations" as const, description: "تبرع" } };
  const r = reviewSpec(spec, { organization: null });
  assert.deepEqual(r.issues, []);
  assert.ok(r.findings.some((f) => f.severity === "blocking"));
  assert.equal(r.approvable, false);
  const ok = reviewSpec(spec, {
    organization: { kind: "charity", verification_status: "verified", donations_eligible: true, apple_nonprofit_approved: false },
  });
  assert.equal(ok.approvable, true);
});
