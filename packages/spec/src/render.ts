import type { AppSpec } from "./schema";

type Locale = "ar" | "en";

const L = {
  ar: {
    goal: "الهدف", audience: "الجمهور", unique: "ما يميّز التطبيق", roles: "الأدوار والصلاحيات", screens: "الشاشات",
    data: "البيانات", auth: "تسجيل الدخول", payments: "الدفع", notifications: "الإشعارات", branding: "الهوية",
    out: "خارج هذا الإصدار", personal: "بيانات شخصية", required: "مطلوب", optional: "اختياري", publicRead: "يراه الزوار",
    ownerScoped: "لكل مستخدم بياناته", everyone: "الجميع", authRequired: "يتطلب حساباً", authOptional: "يعمل دون حساب",
    category: "الفئة", none: "لا يوجد",
    cat: { store: "متجر", restaurant: "مطعم", booking: "حجوزات", directory: "دليل خدمات", content: "محتوى", charity: "جمعية أهلية" },
    pay: { none: "لا يوجد دفع", physical_goods: "بيع منتجات مادية (Moyasar)", services: "بيع خدمات (Moyasar)", digital_content: "محتوى رقمي (عبر Apple In-App Purchase على آيفون)", donations: "تبرعات" },
    auth_m: { email_password: "البريد وكلمة المرور", phone_otp: "رقم الجوال ورمز تحقق", google: "Google", apple: "Apple" },
  },
  en: {
    goal: "Goal", audience: "Audience", unique: "What makes it unique", roles: "Roles and permissions", screens: "Screens",
    data: "Data", auth: "Sign-in", payments: "Payments", notifications: "Notifications", branding: "Branding",
    out: "Not in this version", personal: "personal data", required: "required", optional: "optional", publicRead: "visible to visitors",
    ownerScoped: "each user sees their own", everyone: "Everyone", authRequired: "Account required", authOptional: "Works without an account",
    category: "Category", none: "None",
    cat: { store: "Store", restaurant: "Restaurant", booking: "Bookings", directory: "Services directory", content: "Content", charity: "Charity" },
    pay: { none: "No payments", physical_goods: "Physical goods (Moyasar)", services: "Services (Moyasar)", digital_content: "Digital content (Apple In-App Purchase on iOS)", donations: "Donations" },
    auth_m: { email_password: "Email and password", phone_otp: "Phone number + code", google: "Google", apple: "Apple" },
  },
} as const;

/** Readable spec shown to the owner for approval (stored in app_specs.markdown). */
export function renderSpecMarkdown(spec: AppSpec, locale: Locale = spec.primary_locale): string {
  const t = L[locale];
  const out: string[] = [];
  out.push(`# ${spec.name}`, "", `**${t.category}:** ${t.cat[spec.category]}`, "");
  out.push(`## ${t.goal}`, spec.goal, "", `## ${t.audience}`, spec.audience, "", `## ${t.unique}`, spec.unique_value, "");

  out.push(`## ${t.screens}`);
  spec.screens.forEach((s, i) => {
    out.push(`${i + 1}. **${s.title}** — ${s.purpose}`);
    if (s.elements.length) out.push(`   - ${s.elements.join("، ")}`);
    out.push(`   - ${s.roles.length ? s.roles.join(", ") : t.everyone}`);
  });
  out.push("");

  out.push(`## ${t.data}`);
  if (!spec.entities.length) out.push(t.none);
  for (const e of spec.entities) {
    const tags = [e.owner_scoped ? t.ownerScoped : null, e.public_read ? t.publicRead : null].filter(Boolean).join(" · ");
    out.push(`### ${e.label}${tags ? ` (${tags})` : ""}`, e.description);
    for (const f of e.fields) {
      const extra = [f.required ? t.required : t.optional, f.personal_data ? `⚠️ ${t.personal}` : null].filter(Boolean).join("، ");
      out.push(`- ${f.label} — ${extra}`);
    }
    out.push("");
  }

  out.push(`## ${t.roles}`);
  for (const r of spec.roles) out.push(`- **${r.label}:** ${r.can.join("، ")}`);
  out.push("");

  out.push(`## ${t.auth}`, `${spec.auth.required ? t.authRequired : t.authOptional}: ${spec.auth.methods.map((m) => t.auth_m[m]).join("، ") || t.none}`, "");
  out.push(`## ${t.payments}`, `${t.pay[spec.payments.mode]}${spec.payments.description ? ` — ${spec.payments.description}` : ""}`, "");
  if (spec.notifications.length) out.push(`## ${t.notifications}`, ...spec.notifications.map((n) => `- ${n}`), "");
  out.push(`## ${t.branding}`, `${spec.branding.primary_color} · ${spec.branding.tone}`, "");
  if (spec.out_of_scope.length) out.push(`## ${t.out}`, ...spec.out_of_scope.map((n) => `- ${n}`), "");
  return out.join("\n").trimEnd() + "\n";
}
