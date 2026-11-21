import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { accountPurge } from "../apps/worker/src/handlers/account";
import { RetryLater, type JobRow } from "../apps/worker/src/support";

function adminWithProfile(profile: Record<string, unknown> | null) {
  const touched: string[] = [];
  const chain = (table: string) => {
    touched.push(table);
    const q = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({ data: table === "profiles" ? profile : null, error: null }),
    };
    return q;
  };
  return { admin: { from: chain, auth: { admin: { deleteUser: async () => ({ error: null }) } } } as unknown as SupabaseClient, touched };
}

const job = { id: 1, kind: "account.purge", payload: { userId: "u1" }, attempts: 1, max_attempts: 20 } as unknown as JobRow;

test("purge does nothing after the owner canceled, and waits inside the undo window", async () => {
  const canceled = adminWithProfile({ id: "u1", deletion_scheduled_for: null });
  assert.deepEqual(await accountPurge(canceled.admin, job), { skipped: "canceled" });
  assert.deepEqual(canceled.touched, ["profiles"]);

  const early = adminWithProfile({ id: "u1", deletion_scheduled_for: new Date(Date.now() + 86_400_000).toISOString() });
  await assert.rejects(accountPurge(early.admin, job), RetryLater);
  assert.deepEqual(early.touched, ["profiles"]);

  const gone = adminWithProfile(null);
  assert.deepEqual(await accountPurge(gone.admin, job), { skipped: "already_deleted" });
});
