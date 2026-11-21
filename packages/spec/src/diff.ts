import type { AppSpec } from "./schema";

export interface SpecChange {
  kind: "added" | "removed" | "changed";
  area: "screen" | "entity" | "field" | "role" | "payments" | "auth" | "app";
  name: string;
  detail?: string;
}

/**
 * Structural difference between two specs, used to show the owner what a
 * substantive edit changes before re-approval (FR-002b).
 */
export function diffSpecs(before: AppSpec, after: AppSpec): SpecChange[] {
  const out: SpecChange[] = [];
  const byKey = <T>(xs: T[], k: (x: T) => string) => new Map(xs.map((x) => [k(x), x]));

  const cmpList = <T>(area: SpecChange["area"], a: T[], b: T[], key: (x: T) => string, onBoth?: (x: T, y: T) => void) => {
    const A = byKey(a, key);
    const B = byKey(b, key);
    for (const [k, y] of B) {
      const x = A.get(k);
      if (!x) out.push({ kind: "added", area, name: k });
      else if (onBoth) onBoth(x, y);
      else if (JSON.stringify(x) !== JSON.stringify(y)) out.push({ kind: "changed", area, name: k });
    }
    for (const k of A.keys()) if (!B.has(k)) out.push({ kind: "removed", area, name: k });
  };

  cmpList("screen", before.screens, after.screens, (s) => s.id);
  cmpList("role", before.roles, after.roles, (r) => r.name);
  cmpList("entity", before.entities, after.entities, (e) => e.name, (x, y) => {
    cmpList("field", x.fields.map((f) => ({ ...f, key: `${x.name}.${f.name}` })), y.fields.map((f) => ({ ...f, key: `${y.name}.${f.name}` })), (f) => f.key);
    const { fields: _a, ...restX } = x;
    const { fields: _b, ...restY } = y;
    if (JSON.stringify(restX) !== JSON.stringify(restY)) out.push({ kind: "changed", area: "entity", name: x.name });
  });
  if (before.payments.mode !== after.payments.mode) {
    out.push({ kind: "changed", area: "payments", name: "mode", detail: `${before.payments.mode} → ${after.payments.mode}` });
  }
  if (JSON.stringify(before.auth) !== JSON.stringify(after.auth)) out.push({ kind: "changed", area: "auth", name: "auth" });
  for (const k of ["name", "category", "goal"] as const) {
    if (before[k] !== after[k]) out.push({ kind: "changed", area: "app", name: k });
  }
  return out;
}

/** A change is substantive when it alters screens, data, roles, payments or sign-in (FR-002b). */
export function isSubstantive(changes: SpecChange[]): boolean {
  return changes.some((c) => c.area !== "app" || c.name === "category");
}

/** Fields removed from an entity, or removed entities, delete stored data (FR-004). */
export function destructiveChanges(changes: SpecChange[]): SpecChange[] {
  return changes.filter((c) => c.kind === "removed" && (c.area === "entity" || c.area === "field"));
}
