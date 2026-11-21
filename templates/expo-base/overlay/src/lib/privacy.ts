import { supabase } from "./supabase";

/**
 * Privacy notice (PDPL, FR-011). Platform-owned: the AI cannot edit this file.
 * Bump NOTICE_VERSION whenever the text changes; users are asked to accept again.
 */
export const NOTICE_VERSION = "2026-11";

const owner = process.env.EXPO_PUBLIC_APP_OWNER || "";
const contact = process.env.EXPO_PUBLIC_CONTACT_EMAIL || "";
/** "sa" when the app's data is hosted inside Saudi Arabia, otherwise "outside". */
const location = process.env.EXPO_PUBLIC_DATA_LOCATION === "sa" ? "sa" : "outside";

export interface NoticeSection {
  title: string;
  body: string;
}

export function privacyNotice(locale: "ar" | "en"): NoticeSection[] {
  const ar = locale === "ar";
  const who = owner || (ar ? "صاحب هذا التطبيق" : "the owner of this app");
  const where =
    location === "sa"
      ? ar
        ? "تُحفظ بياناتك داخل المملكة العربية السعودية."
        : "Your data is stored inside Saudi Arabia."
      : ar
        ? "تُحفظ بياناتك لدى مزوّد خدمات سحابية خارج المملكة العربية السعودية، بضمانات حماية تعاقدية، وتوافق على ذلك بقبولك هذا الإشعار."
        : "Your data is stored with a cloud provider outside Saudi Arabia under contractual safeguards; accepting this notice means you agree to that transfer.";
  const reach = contact
    ? ar
      ? `للتواصل بشأن بياناتك: ${contact}`
      : `Contact about your data: ${contact}`
    : ar
      ? "للتواصل بشأن بياناتك استخدم وسيلة التواصل داخل التطبيق."
      : "To contact us about your data, use the contact option in the app.";

  return ar
    ? [
        { title: "من يعالج بياناتك", body: `${who} هو المسؤول عن بياناتك في هذا التطبيق.` },
        { title: "ما نجمعه ولماذا", body: "نجمع ما تدخله بنفسك (مثل الاسم والبريد ورقم الجوال وطلباتك) لتقديم خدمات التطبيق فقط، ولا نبيعه ولا نشاركه للإعلان." },
        { title: "أين تُحفظ", body: where },
        { title: "حقوقك", body: "لك أن تطّلع على بياناتك وتصحّحها، وأن تحذف حسابك وبياناته في أي وقت من صفحة الحساب، وتُحذف خلال 30 يوماً." },
        { title: "التواصل", body: reach },
      ]
    : [
        { title: "Who handles your data", body: `${who} is responsible for your data in this app.` },
        { title: "What we collect and why", body: "We collect only what you enter (such as your name, email, phone and orders) to provide the app's services. We never sell it or share it for advertising." },
        { title: "Where it is stored", body: where },
        { title: "Your rights", body: "You can view and correct your data, and delete your account and its data at any time from the account page; it is erased within 30 days." },
        { title: "Contact", body: reach },
      ];
}

/** Records acceptance of the current notice for the signed-in user. */
export async function acceptPrivacyNotice() {
  const { data } = await supabase.auth.getUser();
  if (!data.user) throw new Error("Sign in first");
  const { error } = await supabase
    .from("privacy_consents")
    .upsert({ user_id: data.user.id, notice_version: NOTICE_VERSION }, { onConflict: "user_id,notice_version", ignoreDuplicates: true });
  if (error) throw error;
}

export async function hasAcceptedPrivacyNotice(): Promise<boolean> {
  const { data } = await supabase.from("privacy_consents").select("id").eq("notice_version", NOTICE_VERSION).limit(1);
  return !!data?.length;
}
