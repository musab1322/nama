import { AppSpecSchema, type AppSpec } from "./schema";

export interface SpecIssue {
  path: string;
  code: string;
  message: string;
}

const SNAKE = /^[a-z][a-z0-9_]{0,62}$/;
const KEBAB = /^[a-z][a-z0-9-]{0,62}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const RESERVED_TABLES = new Set(["users", "profiles", "payments", "donations", "schema_migrations"]);

/**
 * Semantic validation on top of the zod shape. Returns every problem found so the
 * UI (and the model, on retry) can fix them in one pass.
 */
export function validateSpec(input: unknown): { spec: AppSpec | null; issues: SpecIssue[] } {
  const parsed = AppSpecSchema.safeParse(input);
  if (!parsed.success) {
    return {
      spec: null,
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), code: "shape", message: i.message })),
    };
  }
  const s = parsed.data;
  const issues: SpecIssue[] = [];
  const add = (path: string, code: string, message: string) => issues.push({ path, code, message });

  if (s.name.trim().length < 2 || [...s.name].length > 30) add("name", "name_length", "App name must be 2–30 characters");
  if (!s.locales.includes(s.primary_locale)) add("locales", "primary_locale", "locales must include primary_locale");
  if (!HEX.test(s.branding.primary_color)) add("branding.primary_color", "color", "Use a hex color like #2F5D46");
  if (s.goal.trim().length < 20) add("goal", "too_short", "Describe the goal in at least one sentence");
  if (s.screens.length === 0) add("screens", "empty", "At least one screen is required");
  if (s.screens.length > 40) add("screens", "too_many", "At most 40 screens per version");
  if (s.entities.length > 30) add("entities", "too_many", "At most 30 entities per version");

  const roleNames = new Set<string>();
  s.roles.forEach((r, i) => {
    if (!SNAKE.test(r.name)) add(`roles.${i}.name`, "snake_case", `Role "${r.name}" must be snake_case`);
    if (roleNames.has(r.name)) add(`roles.${i}.name`, "duplicate", `Duplicate role "${r.name}"`);
    roleNames.add(r.name);
  });

  const entityNames = new Set<string>();
  s.entities.forEach((e, i) => {
    if (!SNAKE.test(e.name)) add(`entities.${i}.name`, "snake_case", `Entity "${e.name}" must be snake_case`);
    if (RESERVED_TABLES.has(e.name)) add(`entities.${i}.name`, "reserved", `"${e.name}" is reserved by the template`);
    if (entityNames.has(e.name)) add(`entities.${i}.name`, "duplicate", `Duplicate entity "${e.name}"`);
    entityNames.add(e.name);
    const fieldNames = new Set<string>();
    if (e.fields.length === 0) add(`entities.${i}.fields`, "empty", `Entity "${e.name}" has no fields`);
    e.fields.forEach((f, j) => {
      const p = `entities.${i}.fields.${j}`;
      if (!SNAKE.test(f.name)) add(`${p}.name`, "snake_case", `Field "${f.name}" must be snake_case`);
      if (["id", "created_at", "updated_at", "owner_id"].includes(f.name)) add(`${p}.name`, "reserved", `"${f.name}" is added automatically`);
      if (fieldNames.has(f.name)) add(`${p}.name`, "duplicate", `Duplicate field "${f.name}" in ${e.name}`);
      fieldNames.add(f.name);
      if (f.type === "choice" && !(f.choices && f.choices.length >= 2)) add(`${p}.choices`, "choices", "A choice field needs at least 2 choices");
    });
    if (e.public_read && e.fields.some((f) => f.personal_data)) {
      add(`entities.${i}.public_read`, "personal_data_public", `"${e.name}" holds personal data and cannot be publicly readable`);
    }
  });
  s.entities.forEach((e, i) =>
    e.fields.forEach((f, j) => {
      if (f.type === "reference" && !(f.references && entityNames.has(f.references))) {
        add(`entities.${i}.fields.${j}.references`, "bad_reference", `Field "${f.name}" references unknown entity "${f.references}"`);
      }
    }),
  );

  const screenIds = new Set<string>();
  s.screens.forEach((sc, i) => {
    if (!KEBAB.test(sc.id)) add(`screens.${i}.id`, "kebab_case", `Screen id "${sc.id}" must be kebab-case`);
    if (screenIds.has(sc.id)) add(`screens.${i}.id`, "duplicate", `Duplicate screen "${sc.id}"`);
    screenIds.add(sc.id);
    sc.roles.forEach((r) => !roleNames.has(r) && add(`screens.${i}.roles`, "bad_role", `Screen "${sc.id}" uses unknown role "${r}"`));
    sc.entities.forEach((e) => !entityNames.has(e) && add(`screens.${i}.entities`, "bad_entity", `Screen "${sc.id}" uses unknown entity "${e}"`));
  });

  if (s.auth.required && s.auth.methods.length === 0) add("auth.methods", "empty", "Pick at least one sign-in method");
  if (s.auth.methods.includes("google") && !s.auth.methods.includes("apple")) {
    // Apple Guideline 4.8: apps offering third-party login must also offer an equivalent privacy-focused option.
    add("auth.methods", "apple_login_required", "Apps with Google sign-in must also offer Sign in with Apple on iOS");
  }
  if (s.payments.mode !== "none" && !s.payments.description) add("payments.description", "required", "Describe what is paid for");

  return { spec: s, issues };
}
