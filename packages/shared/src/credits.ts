import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "./errors";
import { CREDIT_HOLD, CREDIT_MIN, CREDIT_USD, type CreditOperation } from "./credit-rules";

/**
 * CR-004: credits are metered on the actual AI cost. One credit = $0.10 of Claude
 * usage, rounded up per operation. Before an operation the platform holds up to
 * CREDIT_HOLD (the most the owner can be charged for it); afterwards the unused
 * part goes back. A rare run that costs more than the hold is absorbed by the platform.
 */
export { CREDIT_HOLD, CREDIT_MIN, CREDIT_USD, type CreditOperation };

/** Claude Opus 5.5 list prices, USD per million tokens (5-minute cache writes are 1.25x input). */
export const MODEL_PRICE = { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 } as const;

export interface AiUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export function usageUsd(usages: AiUsage[]): number {
  return usages.reduce(
    (sum, u) =>
      sum +
      (u.input_tokens * MODEL_PRICE.input +
        u.output_tokens * MODEL_PRICE.output +
        (u.cache_creation_input_tokens ?? 0) * MODEL_PRICE.cacheWrite +
        (u.cache_read_input_tokens ?? 0) * MODEL_PRICE.cacheRead) /
        1_000_000,
    0,
  );
}

/** Credits for the given usage, at least 1, never more than the hold. */
export function creditsForUsage(usages: AiUsage[], held: number): number {
  const exact = Math.ceil(usageUsd(usages) / CREDIT_USD - 1e-9);
  return Math.min(held, Math.max(1, exact));
}

/** How much to hold for an operation given the balance; 402 when the balance is below the minimum. */
export function holdFor(op: CreditOperation, balance: number): number {
  if (balance < CREDIT_MIN[op]) {
    throw new HttpError(402, "insufficient_credits", "Not enough credits", { needed: CREDIT_MIN[op] });
  }
  return Math.min(CREDIT_HOLD[op], balance);
}

export async function creditBalance(admin: SupabaseClient, userId: string): Promise<number> {
  const { data, error } = await admin.from("profiles").select("credits_balance").eq("id", userId).single();
  if (error) throw error;
  return (data.credits_balance as number) ?? 0;
}

/**
 * Returns the unused part of a hold. Idempotent per reference, so a job that is
 * re-run after a crash never refunds twice.
 */
export async function settleCredits(admin: SupabaseClient, userId: string, held: number, charged: number, referenceId: string) {
  const back = held - charged;
  if (back <= 0) return;
  const { error } = await admin.from("credit_transactions").insert({
    user_id: userId,
    amount: back,
    reason: "refund",
    reference_id: `${referenceId}:settle`,
    metadata: { held, charged },
  });
  if (error && error.code !== "23505") throw error;
}

/** Atomically spends credits (row lock in Postgres). Throws 402 when the balance is too low. */
export async function spendCredits(admin: SupabaseClient, userId: string, amount: number, referenceId: string) {
  const { data, error } = await admin.rpc("spend_credits", {
    p_user_id: userId,
    p_amount: amount,
    p_reference_id: referenceId,
    p_metadata: {},
  });
  if (error) {
    if (error.message.includes("insufficient_credits")) {
      throw new HttpError(402, "insufficient_credits", "Not enough credits");
    }
    throw error;
  }
  return data as number;
}

/** Refund after a failed generation. Idempotent thanks to (user, reason, reference) uniqueness. */
export async function refundCredits(admin: SupabaseClient, userId: string, amount: number, referenceId: string) {
  const { error } = await admin.from("credit_transactions").insert({
    user_id: userId,
    amount,
    reason: "refund",
    reference_id: referenceId,
  });
  if (error && error.code !== "23505") throw error;
}
