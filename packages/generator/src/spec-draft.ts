import Anthropic from "@anthropic-ai/sdk";
import { env } from "@banna/shared/env";
import { HttpError } from "@banna/shared/errors";
import type { AiUsage } from "@banna/shared/credits";
import { appSpecJsonSchema, type AppSpec } from "@banna/spec/schema";
import type { SpecIssue } from "@banna/spec/validate";
import { MODEL } from "./generate";

/**
 * spec.draft (FR-002a, design §5.1): turns the owner's description into an AppSpec.
 * The model only proposes; `validateSpec` and `checkSpecPolicy` decide.
 */

// Stable system prompt: byte-identical across requests so the prompt cache hits.
const SYSTEM_PROMPT = `You are the product analyst of an app-builder platform for small businesses and charities in Saudi Arabia and the Gulf. The owner describes an app in plain words (often Arabic). You write the app's specification (AppSpec) that the owner will review and approve before any code is generated.

# How to write the spec
- Write every human-readable field (name, labels, goal, audience, purposes, elements, permissions, tone, out_of_scope) in the app's primary language. Use the owner's language unless they ask otherwise. Identifiers stay in English: entity and field names in snake_case (plural table names), role names in snake_case, screen ids in kebab-case.
- Be concrete and specific to this owner: real screen names, real fields, the owner's products or services. unique_value must say what makes this app this owner's own, not a generic template (App Store guideline 4.3).
- Give the app real functionality beyond a website: at least one thing users can do (order, book, save, track, donate, contact) (App Store guideline 4.2).
- Keep the first version small and shippable: usually 4 to 12 screens and 2 to 8 entities. Move extras to out_of_scope with a short reason.
- Never create entities named users, profiles, payments, donations or schema_migrations, and never add fields named id, created_at, updated_at or owner_id: the platform adds those.
- Mark personal_data = true for any field holding personal data of app users (names, phones, emails, addresses, locations, national ids, health). Entities that hold personal data are never public_read.
- If accounts are needed, include a profile or account screen; the platform adds account deletion there. If google sign-in is offered, also offer apple (App Store guideline 4.8).
- payments.mode: physical_goods for products delivered in the real world, services for bookings and services used outside the app, digital_content for anything consumed inside the app (on iOS this must use Apple in-app purchase), donations only when the owner is a charity. Use none when nothing is paid in the app.
- branding.primary_color is a hex color that suits the owner's brand.

# Editing an existing spec
When a current spec is given, return the complete updated spec: keep everything the owner did not ask to change, including names and ids, so the change stays small.

# Fixing problems
When validation problems are listed, return the complete spec with every listed problem fixed.

Return JSON that matches the schema.`;

export interface DraftSpecInput {
  prompt: string;
  category: AppSpec["category"] | null;
  /** The approved (or latest) spec when the owner asks for a change. */
  current: AppSpec | null;
  /** Problems found in a previous attempt, fed back for one repair pass. */
  repair: { previous: unknown; issues: SpecIssue[] } | null;
  /** Receives the token usage of the call (CR-004 metering). */
  onUsage?: (usage: AiUsage) => void;
}

let client: Anthropic | undefined;
const anthropic = () => (client ??= new Anthropic({ apiKey: env().ANTHROPIC_API_KEY }));

/** Returns the model's JSON (not yet validated: callers run validateSpec). */
export async function draftSpec(input: DraftSpecInput): Promise<unknown> {
  const parts: string[] = [];
  if (input.category) parts.push(`<category>${input.category}</category>`);
  if (input.current) parts.push(`<current_spec>\n${JSON.stringify(input.current, null, 2)}\n</current_spec>`);
  parts.push(`<owner_request>\n${input.prompt}\n</owner_request>`);
  if (input.repair) {
    parts.push(
      `<previous_attempt>\n${JSON.stringify(input.repair.previous)}\n</previous_attempt>\n<validation_problems>\n${input.repair.issues
        .map((i) => `- ${i.path || "(root)"}: ${i.message}`)
        .join("\n")}\n</validation_problems>`,
    );
  }

  const stream = anthropic().messages.stream({
    model: MODEL,
    max_tokens: 32000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: { type: "json_schema", schema: appSpecJsonSchema() } },
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: parts.join("\n\n") }],
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
  if (message.stop_reason === "refusal") throw new HttpError(422, "request_declined", "This app can't be specified.");
  if (message.stop_reason === "max_tokens") throw new HttpError(422, "output_too_large", "The description is too large for one spec.");

  const text = message.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(502, "ai_invalid_output", "AI returned malformed output");
  }
}
