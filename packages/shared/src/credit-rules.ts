// CR-004 credit rules. No imports: safe for the browser bundle too.

/** One credit buys this much Claude usage (USD). */
export const CREDIT_USD = 0.1;

export type CreditOperation = "specDraft" | "newApp" | "edit";

/** Most an operation can charge (credits). */
export const CREDIT_HOLD: Record<CreditOperation, number> = { specDraft: 6, newApp: 14, edit: 10 };
/** Least balance needed to start it; below the full hold, the hold is the whole balance. */
export const CREDIT_MIN: Record<CreditOperation, number> = { specDraft: 2, newApp: 8, edit: 2 };
