import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { settleFromMoyasar } from "@banna/integrations/billing";
import type { MoyasarPayment } from "@banna/integrations/moyasar";

/** Records calls; enough of the client for settleFromMoyasar. */
function fakeAdmin(rpcResult: string) {
  const calls: { rpc?: [string, unknown]; update?: unknown }[] = [];
  const chain = (): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop) => (prop === "then" ? (r: (v: unknown) => void) => r({ data: [], error: null }) : chain()),
      apply: () => chain(),
    });
  const admin = {
    rpc: async (name: string, args: unknown) => (calls.push({ rpc: [name, args] }), { data: rpcResult, error: null }),
    from: () => ({
      update: (v: unknown) => (calls.push({ update: v }), chain()),
      select: () => chain(),
    }),
  } as unknown as SupabaseClient;
  return { admin, calls };
}

const paid = (over: Partial<MoyasarPayment> = {}): MoyasarPayment => ({
  id: "pay_abc12345",
  status: "paid",
  amount: 9900,
  currency: "SAR",
  description: null,
  metadata: { payment_id: "11111111-0000-0000-0000-000000000001" },
  source: { type: "creditcard", token: "token_xyz" },
  ...over,
});

test("settles with Moyasar's amount and token, not the caller's", async () => {
  const { admin, calls } = fakeAdmin("credits_added");
  const r = await settleFromMoyasar(admin, "pay_abc12345", { payment: paid() });
  assert.equal(r.outcome, "credits_added");
  assert.deepEqual(calls[0]!.rpc, [
    "settle_platform_payment",
    { p_payment_id: "11111111-0000-0000-0000-000000000001", p_provider_payment_id: "pay_abc12345", p_amount: 9900, p_token: "token_xyz" },
  ]);
});

test("a payment for another of our rows, or without our id, is ignored", async () => {
  const { admin, calls } = fakeAdmin("paid");
  const r1 = await settleFromMoyasar(admin, "pay_abc12345", { payment: paid(), expectedPaymentId: "22222222-0000-0000-0000-000000000002" });
  assert.equal(r1.outcome, "unknown_payment");
  const r2 = await settleFromMoyasar(admin, "pay_abc12345", { payment: paid({ metadata: {} }) });
  assert.equal(r2.outcome, "unknown_payment");
  assert.equal(calls.length, 0);
});

test("unpaid or non-SAR payments grant nothing", async () => {
  const { admin, calls } = fakeAdmin("paid");
  assert.equal((await settleFromMoyasar(admin, "x", { payment: paid({ status: "initiated" }) })).outcome, "not_paid");
  assert.equal((await settleFromMoyasar(admin, "x", { payment: paid({ currency: "USD" }) })).outcome, "not_paid");
  const failed = await settleFromMoyasar(admin, "x", { payment: paid({ status: "failed" }) });
  assert.equal(failed.outcome, "not_paid");
  assert.ok(calls.every((c) => !c.rpc), "no settlement call");
  assert.equal(calls.filter((c) => c.update).length, 1, "a failed payment is recorded");
});

test("owner Moyasar key check: 401 means rejected, the key never goes anywhere else", async () => {
  const { verifySecretKey } = await import("@banna/integrations/moyasar");
  const seen: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push(String(url));
    const auth = new Headers(init.headers).get("authorization") ?? "";
    const key = Buffer.from(auth.replace("Basic ", ""), "base64").toString().replace(/:$/, "");
    return new Response("{}", { status: key === "sk_test_good" ? 200 : 401 });
  }) as typeof fetch;
  try {
    assert.equal(await verifySecretKey("sk_test_good"), "ok");
    assert.equal(await verifySecretKey("sk_test_bad"), "rejected");
    assert.ok(seen.every((u) => u.startsWith("https://api.moyasar.com/v1/")));
  } finally {
    globalThis.fetch = realFetch;
  }
});
