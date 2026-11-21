import { test } from "node:test";
import assert from "node:assert/strict";
import { isPaidSubscription, needsBackend } from "@banna/backends/ensure";
import { assertSecretName } from "@banna/backends/provider";
import { providerFor } from "@banna/backends/registry";
import { migrationRowsFromFiles } from "../apps/worker/src/handlers/backend";
import { flowerShop } from "./fixtures/flower-shop.spec";

test("a static app (no data, no sign-in, no payments) needs no backend", () => {
  assert.equal(needsBackend(flowerShop), true);
  const brochure = {
    ...structuredClone(flowerShop),
    entities: [],
    auth: { required: false, methods: [] },
    payments: { mode: "none" as const, description: null },
  };
  assert.equal(needsBackend(brochure), false);
});

test("paid plan: active or trialing inside the period, past_due only within grace", () => {
  const now = new Date("2026-12-01T00:00:00Z");
  const base = { plan: "free", current_period_end: "2026-12-15T00:00:00Z", grace_until: null, plans: { price_halalas: 9900 } };
  assert.equal(isPaidSubscription({ ...base, status: "active" }, now), true);
  assert.equal(isPaidSubscription({ ...base, status: "trialing" }, now), true);
  assert.equal(isPaidSubscription({ ...base, status: "active", current_period_end: "2026-11-30T00:00:00Z" }, now), false);
  assert.equal(isPaidSubscription({ ...base, status: "active", plans: { price_halalas: 0 } }, now), false);
  assert.equal(isPaidSubscription({ ...base, status: "past_due", grace_until: "2026-12-10T00:00:00Z" }, now), true);
  assert.equal(isPaidSubscription({ ...base, status: "past_due", grace_until: "2026-11-20T00:00:00Z" }, now), false);
  assert.equal(isPaidSubscription({ ...base, status: "canceled" }, now), false);
  assert.equal(isPaidSubscription({ ...base, status: "active", plans: null, plan: "pro" }, now), true);
});

test("migrations are read from the snapshot in timestamp order", () => {
  const rows = migrationRowsFromFiles({
    "supabase/migrations/20261121160000_00_b.sql": "select 2;\n",
    "supabase/migrations/20261121150000_00_a.sql": "select 1;\n",
    "supabase/config.toml": "x",
    "app/index.tsx": "x",
  });
  assert.deepEqual(rows.map((r) => r.name), ["20261121150000_00_a", "20261121160000_00_b"]);
  assert.match(rows[0]!.checksum, /^[a-f0-9]{64}$/);
});

test("providers: both modes exist; Saudi calls fail until the cell is configured; secret names are validated", async () => {
  assert.equal(providerFor("standard").mode, "standard");
  assert.equal(providerFor("saudi").mode, "saudi");
  await assert.rejects(providerFor("saudi").isReady("x")); // no CELL_* settings here
  assert.doesNotThrow(() => assertSecretName("MOYASAR_SECRET_KEY"));
  assert.throws(() => assertSecretName("SUPABASE_URL"));
  assert.throws(() => assertSecretName("lower"));
});
