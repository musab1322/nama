import type { AppSpec } from "@banna/spec/schema";
import { validateSpec, type SpecIssue } from "@banna/spec/validate";
import { checkSpecPolicy, hasBlocking, type OrganizationFacts, type Platform, type PolicyFinding } from "./rules";

/** Every app targets all three; a later per-project setting can narrow this. */
export const DEFAULT_PLATFORMS: Platform[] = ["ios", "android", "web"];

export interface SpecReview {
  spec: AppSpec | null;
  issues: SpecIssue[];
  findings: PolicyFinding[];
  /** True when the spec may be approved: valid shape, no semantic issues, no blocking policy finding. */
  approvable: boolean;
}

/** What the review screen shows and what approval requires (FR-002a, FR-008, FR-015). */
export function reviewSpec(
  content: unknown,
  ctx: { organization: OrganizationFacts | null; platforms?: Platform[] },
): SpecReview {
  const { spec, issues } = validateSpec(content);
  if (!spec) return { spec: null, issues, findings: [], approvable: false };
  const findings = checkSpecPolicy(spec, { platforms: ctx.platforms ?? DEFAULT_PLATFORMS, organization: ctx.organization });
  return { spec, issues, findings, approvable: issues.length === 0 && !hasBlocking(findings) };
}
