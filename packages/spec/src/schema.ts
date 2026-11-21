import { z } from "zod";

/**
 * AppSpec (design 02-design.md §5.1, ADR-007).
 * The wire schema is what Claude fills via structured outputs, so it avoids
 * optional fields (nullable instead) and length limits; `validateSpec` enforces
 * the semantic rules afterwards.
 */

export const CATEGORIES = ["store", "restaurant", "booking", "directory", "content", "charity"] as const;
export const FIELD_TYPES = ["text", "long_text", "number", "money", "boolean", "date", "datetime", "image", "file", "phone", "email", "url", "location", "reference", "choice"] as const;
export const PAYMENT_MODES = ["none", "physical_goods", "services", "digital_content", "donations"] as const;
export const AUTH_METHODS = ["email_password", "phone_otp", "google", "apple"] as const;

const Field = z.object({
  name: z.string().describe("snake_case column name"),
  label: z.string().describe("Label shown to users, in the app's primary language"),
  type: z.enum(FIELD_TYPES),
  required: z.boolean(),
  references: z.string().nullable().describe("Entity name when type = reference, else null"),
  choices: z.array(z.string()).nullable().describe("Allowed values when type = choice, else null"),
  personal_data: z.boolean().describe("True for personal data of app users (names, phones, addresses…)"),
});

const Entity = z.object({
  name: z.string().describe("snake_case table name, plural, e.g. orders"),
  label: z.string(),
  description: z.string(),
  fields: z.array(Field),
  owner_scoped: z.boolean().describe("True when each row belongs to the app user who created it (RLS by owner)"),
  public_read: z.boolean().describe("True when visitors may read rows without signing in (e.g. a product catalogue)"),
});

const Role = z.object({
  name: z.string().describe("snake_case, e.g. customer, staff, admin"),
  label: z.string(),
  can: z.array(z.string()).describe("Plain-language permissions, e.g. 'manage products'"),
});

const Screen = z.object({
  id: z.string().describe("kebab-case route id, e.g. product-details"),
  title: z.string(),
  purpose: z.string(),
  roles: z.array(z.string()).describe("Role names that can open it; empty = everyone"),
  elements: z.array(z.string()).describe("Main UI elements, in order"),
  entities: z.array(z.string()).describe("Entity names read or written on this screen"),
});

export const AppSpecSchema = z.object({
  schema_version: z.literal(1),
  name: z.string().describe("App name, max 30 characters"),
  category: z.enum(CATEGORIES),
  primary_locale: z.enum(["ar", "en"]),
  locales: z.array(z.enum(["ar", "en"])),
  goal: z.string().describe("One paragraph: what the app does and for whom"),
  audience: z.string(),
  unique_value: z.string().describe("What makes this app specific to this owner (helps avoid App Store 4.3 spam rejections)"),
  roles: z.array(Role),
  screens: z.array(Screen),
  entities: z.array(Entity),
  auth: z.object({
    required: z.boolean().describe("False when the app is usable without an account"),
    methods: z.array(z.enum(AUTH_METHODS)),
  }),
  payments: z.object({
    mode: z.enum(PAYMENT_MODES),
    description: z.string().nullable(),
  }),
  notifications: z.array(z.string()).describe("Push/email notifications the app sends"),
  branding: z.object({
    primary_color: z.string().describe("Hex color, e.g. #2F5D46"),
    tone: z.string().describe("Visual and writing tone in a few words"),
  }),
  out_of_scope: z.array(z.string()).describe("Things the owner asked for that this version will not do, and why"),
});

export type AppSpec = z.infer<typeof AppSpecSchema>;
export type SpecEntity = AppSpec["entities"][number];
export type SpecScreen = AppSpec["screens"][number];

/** JSON Schema for Claude structured outputs. */
export function appSpecJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(AppSpecSchema) as Record<string, unknown>;
}
