/**
 * Replaced by the platform when it builds a preview (ADR-010). In every real
 * build PREVIEW is false and the app talks to its own backend.
 */
export const PREVIEW = false;
export const PREVIEW_MIGRATIONS: { name: string; sql: string }[] = [];
export const PREVIEW_SEED = "";
