import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "@banna/shared/env";
import { MODEL } from "./generate";

/**
 * Pre-submission review. One bad app can get the whole platform Play account
 * terminated, so every store submission and every OTA update passes here.
 */
const ModerationSchema = z.object({
  allowed: z.boolean(),
  risk: z.enum(["low", "medium", "high"]),
  reasons: z.array(z.string()),
  policy_refs: z.array(z.string()).describe("e.g. 'Apple 4.2', 'Apple 1.1', 'Google Play: Deceptive Behavior'"),
});
export type Moderation = z.infer<typeof ModerationSchema>;

const SYSTEM = `You review mobile apps before they are submitted to the Apple App Store and Google Play by an app-builder platform.
Decide whether the app is safe to submit. Block (allowed=false) when the app: impersonates a brand, bank or government; is gambling, adult content, weapons/drugs sales, crypto-investment schemes; collects payment card data or credentials outside standard flows; is spam or has no real functionality beyond a website or a single static page (Apple 4.2 Minimum Functionality); changes its primary purpose compared with the previously approved description; or targets children without appropriate design.
Use risk=medium for apps that may pass but need a human look (health, finance, kids, user-generated content without moderation).
Be concrete in reasons. Write reasons in Arabic.`;

let client: Anthropic | undefined;
const anthropic = () => (client ??= new Anthropic({ apiKey: env().ANTHROPIC_API_KEY }));

export async function moderateForStore(input: {
  appName: string;
  description: string;
  approvedDescription: string | null;
  screensSummary: string; // file tree + route names; full code is not needed
  kind: "store_submission" | "ota_update";
}): Promise<Moderation> {
  const message = await anthropic().beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: z.toJSONSchema(ModerationSchema) as Record<string, unknown> },
    },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `<kind>${input.kind}</kind>
<app_name>${input.appName}</app_name>
<description>${input.description}</description>
<previously_approved_description>${input.approvedDescription ?? "(first submission)"}</previously_approved_description>
<app_structure>
${input.screensSummary}
</app_structure>`,
      },
    ],
  });

  if (message.stop_reason === "refusal") {
    return { allowed: false, risk: "high", reasons: ["رُفض الطلب من فاحص الأمان"], policy_refs: [] };
  }
  const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const parsed = ModerationSchema.safeParse(JSON.parse(text));
  if (!parsed.success) return { allowed: false, risk: "high", reasons: ["تعذّر تقييم التطبيق آلياً"], policy_refs: [] };
  return parsed.data;
}
