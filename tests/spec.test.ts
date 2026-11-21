import { test } from "node:test";
import assert from "node:assert/strict";
import { appSpecJsonSchema } from "@banna/spec/schema";
import { validateSpec } from "@banna/spec/validate";
import { renderSpecMarkdown } from "@banna/spec/render";
import { destructiveChanges, diffSpecs, isSubstantive } from "@banna/spec/diff";
import { flowerShop } from "./fixtures/flower-shop.spec";

const clone = <T>(x: T): T => structuredClone(x);
const codes = (input: unknown) => validateSpec(input).issues.map((i) => i.code);

test("FR-002a: a well-formed spec validates with no issues", () => {
  const { spec, issues } = validateSpec(flowerShop);
  assert.deepEqual(issues, []);
  assert.equal(spec?.name, "ورد الرياض");
});

test("FR-002a: JSON schema for structured outputs is generated", () => {
  const schema = appSpecJsonSchema();
  assert.equal(schema.type, "object");
  assert.ok((schema.required as string[]).includes("screens"));
});

test("FR-002a: semantic errors are all reported together", () => {
  const s = clone(flowerShop);
  s.screens[0]!.entities.push("ghosts");
  s.screens[1]!.id = "home";
  s.entities[1]!.fields[0]!.references = "nothing";
  s.entities[0]!.fields.push({ name: "id", label: "x", type: "text", required: false, references: null, choices: null, personal_data: false });
  s.branding.primary_color = "green";
  const c = codes(s);
  for (const expected of ["bad_entity", "duplicate", "bad_reference", "reserved", "color"]) assert.ok(c.includes(expected), expected);
});

test("NFR-004: personal data can never be publicly readable", () => {
  const s = clone(flowerShop);
  s.entities[1]!.public_read = true;
  assert.ok(codes(s).includes("personal_data_public"));
});

test("Apple 4.8: Google sign-in requires Sign in with Apple", () => {
  const s = clone(flowerShop);
  s.auth.methods = ["google"];
  assert.ok(codes(s).includes("apple_login_required"));
  s.auth.methods = ["google", "apple"];
  assert.ok(!codes(s).includes("apple_login_required"));
});

test("shape errors are reported instead of throwing", () => {
  const { spec, issues } = validateSpec({ name: 3 });
  assert.equal(spec, null);
  assert.ok(issues.length > 0 && issues.every((i) => i.code === "shape"));
});

test("FR-010: spec renders in Arabic and English", () => {
  const ar = renderSpecMarkdown(flowerShop, "ar");
  const en = renderSpecMarkdown(flowerShop, "en");
  assert.match(ar, /## الشاشات/);
  assert.match(ar, /⚠️ بيانات شخصية/);
  assert.match(en, /## Screens/);
  assert.match(en, /Physical goods/);
});

test("FR-002b: cosmetic edits are not substantive, data edits are", () => {
  const renamed = clone(flowerShop);
  renamed.goal = "متجر ورد في الرياض بتوصيل في نفس اليوم، مع تتبع الطلب لحظة بلحظة.";
  assert.equal(isSubstantive(diffSpecs(flowerShop, renamed)), false);

  const withReviews = clone(flowerShop);
  withReviews.entities.push({ name: "reviews", label: "التقييمات", description: "", owner_scoped: true, public_read: true,
    fields: [{ name: "stars", label: "النجوم", type: "number", required: true, references: null, choices: null, personal_data: false }] });
  const changes = diffSpecs(flowerShop, withReviews);
  assert.deepEqual(changes, [{ kind: "added", area: "entity", name: "reviews" }]);
  assert.equal(isSubstantive(changes), true);
});

test("FR-004: removing a field is flagged as destructive", () => {
  const s = clone(flowerShop);
  s.entities[1]!.fields = s.entities[1]!.fields.filter((f) => f.name !== "phone");
  const destructive = destructiveChanges(diffSpecs(flowerShop, s));
  assert.deepEqual(destructive, [{ kind: "removed", area: "field", name: "orders.phone" }]);
});
