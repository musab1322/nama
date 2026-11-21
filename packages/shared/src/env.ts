import { z } from "zod";

/**
 * Server-side configuration. Validated lazily (first use) so `next build`
 * does not need production secrets.
 */
const schema = z.object({
  // Platform Supabase (this SaaS)
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SECRET_KEY: z.string().min(1), // sb_secret_* (service_role) — server only

  // Claude
  ANTHROPIC_API_KEY: z.string().min(1),

  // Vercel (hosting the generated apps' web builds)
  VERCEL_TOKEN: z.string().min(1),
  VERCEL_TEAM_ID: z.string().min(1),
  VERCEL_WEBHOOK_SECRET: z.string().min(16),
  PLATFORM_ROOT_DOMAIN: z.string().min(3), // e.g. "yourplatform.app"  → {slug}.yourplatform.app

  // Supabase Management API (one Supabase project per generated app)
  SUPABASE_MANAGEMENT_TOKEN: z.string().min(1),
  SUPABASE_APPS_ORG_SLUG: z.string().min(1),
  SUPABASE_APPS_REGION_GROUP: z.enum(["americas", "emea", "apac"]).default("emea"),
  SUPABASE_MIGRATIONS_ENDPOINT: z.enum(["migrations", "query"]).default("query"),

  // Expo / EAS (worker)
  EXPO_TOKEN: z.string().min(1).optional(),
  EXPO_OWNER: z.string().min(1).optional(), // Expo account / organization that owns all EAS projects
  EXPO_WEBHOOK_SECRET: z.string().min(16),
  BUNDLE_ID_PREFIX: z
    .string()
    .regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/)
    .default("app.yourplatform"),

  // Moyasar: the platform's own account for plans and credits (FR-012)
  MOYASAR_PUBLISHABLE_KEY: z.string().regex(/^pk_(test|live)_/),
  MOYASAR_SECRET_KEY: z.string().regex(/^sk_(test|live)_/),
  /** Shared secret set in the Moyasar dashboard webhook; checked when present (payloads are re-fetched anyway). */
  MOYASAR_WEBHOOK_SECRET: z.string().min(16).optional(),
  /** Public URL of this platform, for payment return pages. */
  PLATFORM_APP_URL: z.string().url(),

  // Saudi cell (FR-017): set only once the cell exists. PEM values; \n escapes are accepted.
  CELL_CONTROL_URL: z.string().url().optional(),
  CELL_CLIENT_CERT: z.string().min(1).optional(),
  CELL_CLIENT_KEY: z.string().min(1).optional(),
  CELL_CA_CERT: z.string().min(1).optional(),

  // Cron + worker
  CRON_SECRET: z.string().min(16),
  WORKER_ID: z.string().default(`worker-${process.pid}`),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
      throw new Error(`Invalid server configuration: ${missing}`);
    }
    cached = parsed.data;
  }
  return cached;
}
