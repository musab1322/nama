import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "@banna/shared/env";
import type { AiUsage } from "@banna/shared/credits";
import { HttpError } from "@banna/shared/errors";
import type { AppSpec } from "@banna/spec/schema";
import { MODEL } from "./generate";

/**
 * Change classifier (FR-002b, design §5.1 "التعديل"): decides whether an edit
 * request stays inside the approved spec (cosmetic: run it now) or changes it
 * (substantive: write a new spec for the owner to approve first).
 */
export const ChangeClassSchema = z.object({
  kind: z.enum(["cosmetic", "substantive"]),
  reason: z.string().describe("One short sentence in the owner's language explaining the decision"),
});
export type ChangeClass = z.infer<typeof ChangeClassSchema>;

const SYSTEM_PROMPT = `You classify an app owner's change request against the app's approved specification.

substantive = the request adds, removes or renames a screen, an entity (data table) or a field; changes roles or who can do what; changes sign-in methods; adds or changes payments or donations; adds notifications; or changes what the app is for.
cosmetic = everything that stays inside the approved spec: colors, fonts, spacing, layout, icons and images, wording and translations, order of existing elements, fixing a bug in existing behaviour.

When the request mixes both, or you are unsure, answer substantive: the owner then reviews the updated spec before anything is built.
Return JSON that matches the schema.`;

let client: Anthropic | undefined;
const anthropic = () => (client ??= new Anthropic({ apiKey: env().ANTHROPIC_API_KEY }));

export async function classifyChange(input: { prompt: string; spec: AppSpec; onUsage?: (usage: AiUsage) => void }): Promise<ChangeClass> {
  // Only the structure matters for this decision; leave out descriptive text to keep it cheap.
  const outline = {
    name: input.spec.name,
    goal: input.spec.goal,
    screens: input.spec.screens.map((s) => ({ id: s.id, title: s.title, elements: s.elements })),
    entities: input.spec.entities.map((e) => ({ name: e.name, fields: e.fields.map((f) => f.name) })),
    roles: input.spec.roles.map((r) => r.name),
    auth: input.spec.auth,
    payments: input.spec.payments.mode,
    notifications: input.spec.notifications,
  };

  let message;
  try {
    message = await anthropic().messages.create({
      model: MODEL,
      max_tokens: 1024,
      output_config: { effort: "low", format: { type: "json_schema", schema: z.toJSONSchema(ChangeClassSchema) as Record<string, unknown> } },
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: `<approved_spec_outline>\n${JSON.stringify(outline)}\n</approved_spec_outline>\n\n<change_request>\n${input.prompt}\n</change_request>`,
        },
      ],
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) throw new HttpError(503, "ai_busy", "AI is busy, try again shortly");
    if (err instanceof Anthropic.APIConnectionError) throw new HttpError(503, "ai_unreachable", "AI temporarily unavailable");
    throw err;
  }
  input.onUsage?.(message.usage);
  if (message.stop_reason === "refusal") throw new HttpError(422, "request_declined", "This request can't be generated.");

  const text = message.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
  try {
    const parsed = ChangeClassSchema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
  } catch {
    // fall through
  }
  // Fail safe: an unreadable answer sends the change through spec review.
  return { kind: "substantive", reason: "" };
}
