import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "@banna/shared/env";
import { HttpError } from "@banna/shared/errors";
import { isLockedPath, normalizePath, type ProjectFiles } from "@banna/shared/snapshots";
import type { AppSpec } from "@banna/spec/schema";
import type { SpecChange } from "@banna/spec/diff";
import type { AiUsage } from "@banna/shared/credits";

export const MODEL = "claude-opus-5-5";

// ---------------------------------------------------------------------------
// Output contract (structured outputs: every field required, optional = nullable)
// ---------------------------------------------------------------------------
export const GenerationSchema = z.object({
  summary: z.string().describe("What changed, in the user's language, 1-4 sentences."),
  app_name: z.string().nullable().describe("Suggested app name (only on the first generation), else null."),
  operations: z
    .array(
      z.object({
        type: z.enum(["write", "delete"]),
        path: z.string().describe("POSIX path relative to the project root."),
        content: z.string().nullable().describe("Full new file content for write; null for delete."),
      }),
    )
    .describe("Full-file writes/deletes. Never partial diffs."),
  backend_migrations: z
    .array(
      z.object({
        name: z.string().describe("snake_case, e.g. create_orders"),
        sql: z.string().describe("Idempotent Postgres SQL for the app's own Supabase project, with RLS."),
      }),
    )
    .describe("New database changes only; empty if none."),
  needs_native_change: z
    .string()
    .nullable()
    .describe("If the request needs a native capability or new dependency the template lacks, explain; else null."),
});
export type Generation = z.infer<typeof GenerationSchema>;

// Stable system prompt: kept byte-identical so the prompt cache hits on every request.
const SYSTEM_PROMPT = `You are the code engine of an app-builder platform. Non-technical users describe an app in natural language (often Arabic) and you produce or edit a complete, working Expo (React Native + expo-router + TypeScript) project that runs on iOS, Android, and the web (React Native Web).

# Project rules
- The project starts from the platform template you are given. Keep its structure: routes in src/app/ (expo-router), shared UI in src/components/, logic in src/lib/, imported with the @/ alias ("@/lib/supabase" is src/lib/supabase.ts).
- You may only use dependencies already present in package.json. Do not add packages. If the request truly needs one, implement without it if reasonable, otherwise explain in needs_native_change.
- Never write these platform-owned files: package.json, package-lock.json, app.json, app.config.*, eas.json, babel/metro config, tsconfig.json, ios/, android/, plugins/, src/lib/supabase.ts, src/lib/preview/, src/lib/privacy.ts, src/lib/payments.ts, src/lib/updates.ts, src/app/privacy.tsx, src/components/PrivacyConsent.tsx, supabase/, or any dotfile. Read them for context only.
- Privacy (PDPL): every sign-up form shows <PrivacyConsent> from @/components/PrivacyConsent and cannot submit until it is checked; right after sign-up call acceptPrivacyNotice() from @/lib/privacy. Link to /privacy from the account screen.
- Payments: physical goods and services are paid with pay(referenceType, referenceId) from @/lib/payments. The price is computed in the database: in backend_migrations, replace public.payment_amount_for(p_reference_type text, p_reference_id text, p_user_id uuid) returns integer (halalas; raise when p_user_id may not pay for that reference) and public.on_payment_paid(p_reference_type text, p_reference_id text) (e.g. mark the order paid), both "security definer set search_path = ''", using schema-qualified names. Never ask for card details in the app.
- Preview data: write demo rows for the preview in preview/seed.sql (plain INSERT statements, only into tables that visitors can read without signing in, realistic fake data in the app's language, no real people's data, no rows in auth.users). It never runs in production.
- The published web app is static files only: no API routes, no server functions in the app code.
- Backend: every app has its OWN Supabase project. Use the exported client from lib/supabase.ts (import { supabase } from "@/lib/supabase"). Auth = Supabase Auth (email + password, and Google when configured). Never hardcode keys or URLs.
- Database changes go in backend_migrations as Postgres SQL: create tables in schema public, ALWAYS enable row level security and add policies scoped to auth.uid(), grant only what is needed to the authenticated role, use "if not exists" where possible. Never touch the auth, storage or vault schemas except to reference auth.users(id). Never drop or truncate existing tables or columns unless the user explicitly asked to delete that data.
- Any screen with sign-in must keep the account deletion option that the template provides (App Store requirement).
- UI: support RTL Arabic and LTR English via I18nManager-safe layouts (use start/end, not left/right). Accessible labels, safe areas, loading and error states. Works on small phones and on desktop web.
- No external network calls except to the app's own Supabase project. No remote code loading, no eval.
- Write complete files. Each operation replaces the whole file. Only include files that actually change.
- Keep the app's main purpose unchanged across edits unless the user explicitly asks for a different app (store policy: over-the-air updates must not change an app's primary purpose).

# The approved spec
- The owner approved a specification (approved_spec). It is the contract: build exactly its screens, entities, fields, roles, auth methods and payment mode. Do not add screens, tables or features that it does not list, and do not drop any that it lists.
- Entities map to tables with the same names; add id, created_at, updated_at and owner_id (when owner_scoped) yourself. Fields with personal_data = true are never readable without sign-in. public_read entities get a select policy for anon.
- payments.mode: physical_goods and services use the app's Moyasar checkout function provided by the template; digital_content on iOS must not offer any other payment than Apple in-app purchase; donations only appear when the spec has them. none means no payment UI.
- When spec_changes is given, the spec was revised: implement those changes on top of the existing code and keep everything else as it is.
- A request of kind "cosmetic_edit" is a visual or wording change within the approved spec: change only what it asks for.

# Output
Return JSON matching the schema. summary must be written in the same language as the user's request.`;

export interface GenerateInput {
  isNewProject: boolean;
  prompt: string;
  /** The approved spec the code must implement (FR-002). */
  spec: AppSpec | null;
  /** Changes since the previous approved spec, when this run follows a re-approval. */
  specChanges: SpecChange[] | null;
  kind: "new_app" | "spec_update" | "cosmetic_edit";
  files: ProjectFiles;
  history: { prompt: string; summary: string }[];
  /** Receives the token usage of every model call (CR-004 metering). */
  onUsage?: (usage: AiUsage) => void;
}

function renderFiles(files: ProjectFiles): string {
  const paths = Object.keys(files).sort();
  const tree = paths.map((p) => `${isLockedPath(p) ? "[locked] " : ""}${p}`).join("\n");
  const bodies = paths.map((p) => `<file path="${p}">\n${files[p]}\n</file>`).join("\n\n");
  return `<file_tree>\n${tree}\n</file_tree>\n\n<files>\n${bodies}\n</files>`;
}

/** The approved spec (and what changed) as prompt context. */
export function renderSpecContext(input: Pick<GenerateInput, "spec" | "specChanges">): string {
  if (!input.spec) return "";
  const changes = input.specChanges?.length
    ? `<spec_changes>\n${input.specChanges.map((c) => `- ${c.kind} ${c.area} ${c.name}${c.detail ? `: ${c.detail}` : ""}`).join("\n")}\n</spec_changes>\n\n`
    : "";
  return `<approved_spec>\n${JSON.stringify(input.spec, null, 2)}\n</approved_spec>\n\n${changes}`;
}

let client: Anthropic | undefined;
const anthropic = () => (client ??= new Anthropic({ apiKey: env().ANTHROPIC_API_KEY }));

export async function generateApp(input: GenerateInput): Promise<Generation> {
  const historyText = input.history.length
    ? input.history.map((h, i) => `${i + 1}. Request: ${h.prompt}\n   Result: ${h.summary}`).join("\n")
    : "(none)";

  const stream = anthropic().beta.messages.stream({
    model: MODEL,
    max_tokens: input.isNewProject ? 128000 : 64000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default", // re-run on a fallback model if the request is declined by a safety classifier
    thinking: { type: "adaptive" },
    output_config: {
      effort: input.isNewProject ? "high" : "medium",
      format: { type: "json_schema", schema: z.toJSONSchema(GenerationSchema) as Record<string, unknown> },
    },
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: [
          // Project files change per version, but within an editing session they are re-sent
          // unchanged until the next write, so they are worth caching too.
          { type: "text", text: renderFiles(input.files), cache_control: { type: "ephemeral" } },
          {
            type: "text",
            text: `${renderSpecContext(input)}<previous_requests>\n${historyText}\n</previous_requests>\n\n<request kind="${input.kind}">\n${input.prompt}\n</request>`,
          },
        ],
      },
    ],
  });

  let message;
  try {
    message = await stream.finalMessage();
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) throw new HttpError(503, "ai_busy", "AI is busy, try again shortly");
    if (err instanceof Anthropic.APIConnectionError) throw new HttpError(503, "ai_unreachable", "AI temporarily unavailable");
    throw err;
  }
  input.onUsage?.(message.usage);

  if (message.stop_reason === "refusal") {
    throw new HttpError(422, "request_declined", "This request can't be generated.");
  }
  if (message.stop_reason === "max_tokens") {
    throw new HttpError(422, "output_too_large", "The change is too large for one step. Split it into smaller requests.");
  }

  const text = message.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    throw new HttpError(502, "ai_invalid_output", "AI returned malformed output");
  }
  const result = GenerationSchema.safeParse(parsedJson);
  if (!result.success) throw new HttpError(502, "ai_invalid_output", "AI output failed validation");
  return result.data;
}

/** Applies operations with path validation. Locked files are silently protected. */
export function applyOperations(base: ProjectFiles, ops: Generation["operations"]) {
  const files: ProjectFiles = { ...base };
  const rejected: string[] = [];
  for (const op of ops) {
    let path: string;
    try {
      path = normalizePath(op.path);
    } catch {
      rejected.push(op.path);
      continue;
    }
    if (isLockedPath(path)) {
      rejected.push(path);
      continue;
    }
    if (op.type === "delete") delete files[path];
    else if (op.content !== null) files[path] = op.content;
  }
  return { files, rejected };
}

// ---------------------------------------------------------------------------
// SQL guard for AI-generated backend migrations
// ---------------------------------------------------------------------------
const DESTRUCTIVE = [
  /\bdrop\s+(table|schema|column|type|view|materialized\s+view|function|policy|index)\b/i,
  /\btruncate\b/i,
  /\balter\s+table\b[^;]*\bdrop\b/i,
  /\bdelete\s+from\s+[\w."]+\s*(;|$)/i, // DELETE without WHERE
  /\bupdate\s+[\w."]+\s+set\b(?![^;]*\bwhere\b)[^;]*(;|$)/i, // UPDATE without WHERE
];
const FORBIDDEN = [
  /\b(alter|drop|truncate|grant|revoke)\b[^;]*\b(auth|storage|vault|realtime|supabase_\w+|pg_catalog|extensions)\./i,
  /\bcreate\s+(or\s+replace\s+)?function\s+(auth|storage|vault)\./i,
  /\b(alter|create|drop)\s+(role|user|database)\b/i,
  /\bcopy\b[^;]*\b(from|to)\s+program\b/i,
  /\bsecurity\s+definer\b(?![\s\S]*set\s+search_path)/i, // definer functions must pin search_path
];

export function classifyMigrationSql(sql: string): { destructive: boolean; forbiddenReason: string | null } {
  const stripped = sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const forbidden = FORBIDDEN.find((re) => re.test(stripped));
  return {
    destructive: DESTRUCTIVE.some((re) => re.test(stripped)),
    forbiddenReason: forbidden ? `blocked pattern: ${forbidden.source}` : null,
  };
}
