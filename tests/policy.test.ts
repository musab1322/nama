import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSpecPolicy, donationMode, hasBlocking, type OrganizationFacts } from "@banna/policy/rules";
import { flowerShop } from "./fixtures/flower-shop.spec";

const verifiedCharity: OrganizationFacts = { kind: "charity", verification_status: "verified", donations_eligible: true, apple_nonprofit_approved: false };
const codes = (f: { code: string }[]) => f.map((x) => x.code);

test("donation mode: only verified eligible charities; iOS needs Apple approval for in-app", () => {
  assert.equal(donationMode("android", null), "not_allowed");
  assert.equal(donationMode("android", { ...verifiedCharity, kind: "business" }), "not_allowed");
  assert.equal(donationMode("android", { ...verifiedCharity, verification_status: "pending" }), "not_allowed");
  assert.equal(donationMode("android", verifiedCharity), "in_app");
  assert.equal(donationMode("ios", verifiedCharity), "external_link");
  assert.equal(donationMode("ios", { ...verifiedCharity, apple_nonprofit_approved: true }), "in_app");
});

test("donations by an unverified organisation are blocking", () => {
  const spec = { ...structuredClone(flowerShop), category: "charity" as const, payments: { mode: "donations" as const, description: "تبرع" } };
  const f = checkSpecPolicy(spec, { platforms: ["web", "android", "ios"], organization: null });
  assert.ok(hasBlocking(f));
  const ok = checkSpecPolicy(spec, { platforms: ["web", "android", "ios"], organization: verifiedCharity });
  assert.equal(hasBlocking(ok), false);
  assert.ok(codes(ok).includes("ios_donations_external"));
});

test("FR-015: digital content on iOS is flagged for In-App Purchase", () => {
  const spec = { ...structuredClone(flowerShop), payments: { mode: "digital_content" as const, description: "دورات" } };
  assert.ok(codes(checkSpecPolicy(spec, { platforms: ["ios"], organization: null })).includes("ios_digital_requires_iap"));
  assert.ok(!codes(checkSpecPolicy(spec, { platforms: ["android"], organization: null })).includes("ios_digital_requires_iap"));
});

test("Apple 4.2 / 4.3 warnings for thin or generic apps", () => {
  const spec = structuredClone(flowerShop);
  spec.screens = spec.screens.slice(0, 2);
  spec.unique_value = "متجر";
  const c = codes(checkSpecPolicy(spec, { platforms: ["ios"], organization: null }));
  assert.ok(c.includes("minimum_functionality") && c.includes("generic_app_risk"));
});

test("NFR-004 + 5.1.1(v): privacy notice and account screen are flagged", () => {
  const c = codes(checkSpecPolicy(flowerShop, { platforms: ["web", "ios"], organization: null }));
  assert.ok(c.includes("privacy_notice_required"));
  assert.ok(c.includes("account_screen_missing"));
  assert.equal(hasBlocking(checkSpecPolicy(flowerShop, { platforms: ["web", "ios"], organization: null })), false);
});
