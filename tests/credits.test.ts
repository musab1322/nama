import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CREDIT_HOLD, creditsForUsage, holdFor, settleCredits, usageUsd } from "../packages/shared/src/credits";
import { HttpError } from "../packages/shared/src/errors";

test("CR-004: usage is priced at Opus 5.5 list prices", () => {
  // 10k input ($0.04) + 5k output ($0.10) + 20k cache read ($0.004) + 4k cache write ($0.02)
  const usd = usageUsd([{ input_tokens: 10_000, output_tokens: 5_000, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 4_000 }]);
  assert.ok(Math.abs(usd - 0.164) < 1e-9);
});

test("CR-004: credits round up to $0.10, at least 1, never more than the hold", () => {
  assert.equal(creditsForUsage([{ input_tokens: 100, output_tokens: 10 }], 10), 1);
  // $0.20 exactly = 2 credits (no float drift to 3)
  assert.equal(creditsForUsage([{ input_tokens: 0, output_tokens: 10_000 }], 10), 2);
  // typical edit: 60k cached input read, 2k fresh input, 15k output = $0.32 -> 4
  assert.equal(creditsForUsage([{ input_tokens: 2_000, output_tokens: 15_000, cache_read_input_tokens: 60_000 }], 10), 4);
  // several calls add up (spec draft + repair pass)
  assert.equal(creditsForUsage([{ input_tokens: 0, output_tokens: 10_000 }, { input_tokens: 0, output_tokens: 10_000 }], 10), 4);
  // a huge run is capped at the hold; the platform absorbs the rest
  assert.equal(creditsForUsage([{ input_tokens: 50_000, output_tokens: 128_000 }], CREDIT_HOLD.newApp), CREDIT_HOLD.newApp);
});

test("CR-004: hold is the full maximum, or the whole balance above the minimum", () => {
  assert.equal(holdFor("edit", 100), CREDIT_HOLD.edit);
  assert.equal(holdFor("edit", 5), 5);
  assert.equal(holdFor("newApp", 14), 14);
  assert.throws(() => holdFor("newApp", 7), (e: unknown) => e instanceof HttpError && e.status === 402 && e.code === "insufficient_credits");
  // signup credits (20) cover a spec and a first build
  const afterSpec = 20 - 3;
  assert.equal(holdFor("specDraft", 20), CREDIT_HOLD.specDraft);
  assert.equal(holdFor("newApp", afterSpec), CREDIT_HOLD.newApp);
});

test("CR-004: settlement returns the unused hold once, under its own reference", async () => {
  const rows: Record<string, unknown>[] = [];
  const admin = {
    from: () => ({
      insert: async (row: Record<string, unknown>) => {
        if (rows.some((r) => r.reference_id === row.reference_id)) return { error: { code: "23505" } };
        rows.push(row);
        return { error: null };
      },
    }),
  } as unknown as SupabaseClient;
  await settleCredits(admin, "u1", 10, 4, "generate:abc");
  await settleCredits(admin, "u1", 10, 4, "generate:abc"); // replay: no second refund
  await settleCredits(admin, "u1", 10, 10, "generate:def"); // nothing to return
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { user_id: "u1", amount: 6, reason: "refund", reference_id: "generate:abc:settle", metadata: { held: 10, charged: 4 } });
});
