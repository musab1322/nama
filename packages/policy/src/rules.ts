import type { AppSpec } from "@banna/spec/schema";

/**
 * Deterministic store / payment / donation rules (FR-008, FR-015, requirements §7).
 * The AI moderation in @banna/generator handles judgement calls; these rules are
 * the hard lines that never depend on a model's opinion.
 */

export type Platform = "ios" | "android" | "web";

export interface OrganizationFacts {
  kind: "business" | "charity";
  verification_status: "unverified" | "pending" | "verified" | "rejected";
  donations_eligible: boolean;
  apple_nonprofit_approved: boolean;
}

export interface PolicyFinding {
  code: string;
  severity: "blocking" | "warning";
  platforms: Platform[];
  ar: string;
  en: string;
  ref?: string;
}

export type DonationMode = "in_app" | "external_link" | "not_allowed";

/** Where a donate button may take payment on each platform. */
export function donationMode(platform: Platform, org: OrganizationFacts | null): DonationMode {
  if (!org || org.kind !== "charity" || org.verification_status !== "verified" || !org.donations_eligible) return "not_allowed";
  if (platform === "ios") return org.apple_nonprofit_approved ? "in_app" : "external_link";
  return "in_app";
}

export function checkSpecPolicy(spec: AppSpec, ctx: { platforms: Platform[]; organization: OrganizationFacts | null }): PolicyFinding[] {
  const out: PolicyFinding[] = [];
  const mobile = ctx.platforms.filter((p): p is "ios" | "android" => p !== "web");

  // FR-015: digital goods on iOS must use Apple In-App Purchase (Guideline 3.1.1).
  if (spec.payments.mode === "digital_content" && ctx.platforms.includes("ios")) {
    out.push({
      code: "ios_digital_requires_iap", severity: "warning", platforms: ["ios"], ref: "Apple 3.1.1",
      ar: "بيع المحتوى الرقمي في آيفون يتم عبر Apple In-App Purchase فقط، وتأخذ Apple عمولة. سنبنيه بهذه الطريقة في نسخة آيفون.",
      en: "Digital content on iPhone must be sold through Apple In-App Purchase (Apple takes a commission). The iOS build will use it.",
    });
  }

  // Donations (requirements §7): verified + eligible charity only; Apple approval for in-app on iOS.
  if (spec.payments.mode === "donations" || spec.category === "charity") {
    const modes = ctx.platforms.map((p) => [p, donationMode(p, ctx.organization)] as const);
    if (spec.payments.mode === "donations" && modes.some(([, m]) => m === "not_allowed")) {
      out.push({
        code: "donations_require_verified_charity", severity: "blocking", platforms: modes.filter(([, m]) => m === "not_allowed").map(([p]) => p), ref: "Apple 3.2.1(vi), Google Play Payments",
        ar: "جمع التبرعات متاح فقط لجمعية موثقة لدينا بترخيص ساري. أكمل توثيق الجمعية أولاً، أو احذف التبرعات من هذه النسخة.",
        en: "Donations are only available to a verified charity with a valid licence. Complete verification first, or remove donations from this version.",
      });
    }
    if (spec.payments.mode === "donations" && modes.some(([p, m]) => p === "ios" && m === "external_link")) {
      out.push({
        code: "ios_donations_external", severity: "warning", platforms: ["ios"], ref: "Apple 3.2.1(vi)",
        ar: "في آيفون سيفتح زر التبرع صفحة التبرع في المتصفح، لأن Apple لم تعتمد جمعيتك بعد لجمع التبرعات داخل التطبيق.",
        en: "On iPhone the donate button will open the donation page in the browser until Apple approves your charity for in-app fundraising.",
      });
    }
  }

  // Apple 4.2 minimum functionality / 4.3 spam: thin or generic apps get rejected.
  if (mobile.length) {
    if (spec.screens.length < 3) {
      out.push({
        code: "minimum_functionality", severity: "warning", platforms: mobile, ref: "Apple 4.2",
        ar: "التطبيقات قليلة الشاشات تُرفض غالباً في App Store. أضف شاشات تقدّم قيمة حقيقية لمستخدميك.",
        en: "Apps with very few screens are often rejected. Add screens that give your users real value.",
      });
    }
    if (spec.unique_value.trim().length < 25) {
      out.push({
        code: "generic_app_risk", severity: "warning", platforms: ["ios"], ref: "Apple 4.3",
        ar: "اكتب ما يميّز تطبيقك عن غيره (محتواك، خدماتك، منطقتك). Apple ترفض التطبيقات المتشابهة المبنية من قوالب.",
        en: "Describe what makes your app specific (your content, services, area). Apple rejects look-alike template apps.",
      });
    }
  }

  // Apple 5.1.1(v): account deletion when accounts exist. The template always provides it; this guards custom specs.
  if (spec.auth.methods.length && !spec.screens.some((s) => /account|settings|profile|حساب|إعدادات/i.test(`${s.id} ${s.title}`))) {
    out.push({
      code: "account_screen_missing", severity: "warning", platforms: mobile.length ? mobile : ["web"], ref: "Apple 5.1.1(v)",
      ar: "سنضيف شاشة «حسابي» فيها حذف الحساب، لأن المتاجر تشترطها في أي تطبيق فيه تسجيل دخول.",
      en: "We'll add a “My account” screen with account deletion, which the stores require for any app with sign-in.",
    });
  }

  // NFR-004: personal data must be collected with a privacy notice; flag what the notice must mention.
  const personal = spec.entities.flatMap((e) => e.fields.filter((f) => f.personal_data).map((f) => `${e.label}: ${f.label}`));
  if (personal.length) {
    out.push({
      code: "privacy_notice_required", severity: "warning", platforms: ctx.platforms, ref: "PDPL",
      ar: `يجمع التطبيق بيانات شخصية (${personal.join("، ")}). سنضيف إشعار الخصوصية وطلب الموافقة تلقائياً.`,
      en: `The app collects personal data (${personal.join(", ")}). A privacy notice and consent step will be added automatically.`,
    });
  }
  return out;
}

export const hasBlocking = (findings: PolicyFinding[]) => findings.some((f) => f.severity === "blocking");
