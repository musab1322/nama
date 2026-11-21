/**
 * Developer account guide (FR-006b): what the owner has to do on Apple's and
 * Google's sites, in order. Fees and rules are the stores' as of 2026-11; the
 * wizard links to the official pages so the owner always sees the current terms.
 */

export type Store = "apple" | "google";
export type AccountType = "individual" | "organization";

export interface GuideStep {
  id: string;
  ar: string;
  en: string;
  url?: string;
}

export interface AccountGuide {
  store: Store;
  type: AccountType;
  feeNote: { ar: string; en: string };
  steps: GuideStep[];
}

const APPLE_COMMON: GuideStep[] = [
  {
    id: "asc_key",
    ar: "في App Store Connect: المستخدمون والوصول ← التكاملات ← مفاتيح API. أنشئ مفتاحاً بدور «App Manager» ونزّل ملف ‎.p8 (يُنزَّل مرة واحدة فقط).",
    en: "In App Store Connect: Users and Access → Integrations → API keys. Create a key with the App Manager role and download the .p8 file (it downloads only once).",
    url: "https://appstoreconnect.apple.com/access/integrations/api",
  },
  {
    id: "asc_upload",
    ar: "ارفع الملف هنا مع Key ID وIssuer ID وTeam ID. نحفظ المفتاح مشفراً ولا يظهر لأحد.",
    en: "Upload the file here with the Key ID, Issuer ID and Team ID. The key is stored encrypted and is never shown to anyone.",
  },
];

const GOOGLE_COMMON: GuideStep[] = [
  {
    id: "gcp_service_account",
    ar: "في Google Cloud Console أنشئ مشروعاً (أو استخدم مشروعاً قائماً)، وفعّل «Google Play Android Developer API»، ثم أنشئ حساب خدمة ونزّل مفتاحه بصيغة JSON.",
    en: "In Google Cloud Console, create (or pick) a project, enable the Google Play Android Developer API, then create a service account and download a JSON key for it.",
    url: "https://console.cloud.google.com/iam-admin/serviceaccounts",
  },
  {
    id: "play_invite",
    ar: "في Play Console: المستخدمون والأذونات ← دعوة مستخدم جديد. أضف بريد حساب الخدمة وامنحه صلاحيات إدارة الإصدارات (Release manager).",
    en: "In Play Console: Users and permissions → Invite new user. Add the service account's email and give it release management permissions (Release manager).",
    url: "https://play.google.com/console/users-and-permissions",
  },
  {
    id: "play_create_app",
    ar: "أنشئ التطبيق مرة واحدة يدوياً في Play Console (Google لا تسمح بإنشائه برمجياً). سنخبرك بالاسم ومعرّف الحزمة عند أول نشر.",
    en: "Create the app once by hand in Play Console (Google does not allow creating it through the API). We show you the name and package name at your first release.",
    url: "https://play.google.com/console",
  },
  {
    id: "play_upload",
    ar: "ارفع ملف JSON هنا مع رقم المطوّر (الرقم في رابط Play Console). نحفظه مشفراً.",
    en: "Upload the JSON file here with your developer ID (the number in your Play Console URL). It is stored encrypted.",
  },
];

export function accountGuide(store: Store, type: AccountType): AccountGuide {
  if (store === "apple") {
    return {
      store,
      type,
      feeNote: { ar: "اشتراك برنامج Apple للمطورين سنوي (99 دولاراً حالياً) يُدفع لـ Apple مباشرة.", en: "The Apple Developer Program is a yearly membership (currently USD 99) paid to Apple directly." },
      steps: [
        type === "organization"
          ? {
              id: "duns",
              ar: "احصل على رقم D-U-N-S لمنشأتك أو جمعيتك (مجاني، وقد يستغرق أياماً). الاسم القانوني يجب أن يطابق السجل التجاري أو ترخيص الجمعية.",
              en: "Get a D-U-N-S number for your business or charity (free, may take days). The legal name must match your commercial registration or charity licence.",
              url: "https://developer.apple.com/enroll/duns-lookup/",
            }
          : {
              id: "apple_id",
              ar: "استخدم Apple ID باسمك الحقيقي مع تفعيل التحقق بخطوتين. سيظهر اسمك كبائع في المتجر.",
              en: "Use an Apple ID in your real name with two-factor authentication on. Your name is shown as the seller on the App Store.",
            },
        {
          id: "apple_enroll",
          ar: type === "organization" ? "سجّل في برنامج Apple للمطورين كمنظمة." : "سجّل في برنامج Apple للمطورين كفرد.",
          en: type === "organization" ? "Enroll in the Apple Developer Program as an organization." : "Enroll in the Apple Developer Program as an individual.",
          url: "https://developer.apple.com/programs/enroll/",
        },
        ...APPLE_COMMON,
      ],
    };
  }
  return {
    store,
    type,
    feeNote: { ar: "رسوم تسجيل Google Play تُدفع مرة واحدة (25 دولاراً حالياً) لـ Google مباشرة.", en: "Google Play registration is a one-time fee (currently USD 25) paid to Google directly." },
    steps: [
      {
        id: "play_register",
        ar:
          type === "organization"
            ? "أنشئ حساب مطوّر من نوع «منظمة» في Play Console، مع رقم D-U-N-S وتحقق من هوية المنشأة."
            : "أنشئ حساب مطوّر «شخصي» في Play Console وأكمل التحقق من هويتك.",
        en:
          type === "organization"
            ? "Create an Organization developer account in Play Console, with a D-U-N-S number and business verification."
            : "Create a Personal developer account in Play Console and complete identity verification.",
        url: "https://play.google.com/console/signup",
      },
      ...(type === "individual"
        ? [
            {
              id: "closed_test",
              ar: "مهم: الحسابات الشخصية الجديدة لا تنشر للعامة مباشرة. Google تشترط اختباراً مغلقاً بـ 12 مختبِراً على الأقل لمدة 14 يوماً متواصلة، ثم طلب الوصول للإنتاج من Play Console. سننشر أول إصدار على مسار الاختبار المغلق تلقائياً ونعدّ لك الأيام.",
              en: "Important: new personal accounts cannot publish to everyone straight away. Google requires a closed test with at least 12 testers for 14 days in a row, then you apply for production access in Play Console. We publish your first release to the closed track automatically and count the days for you.",
              url: "https://support.google.com/googleplay/android-developer/answer/14151465",
            },
          ]
        : []),
      ...GOOGLE_COMMON,
    ],
  };
}

export const CLOSED_TEST_DAYS = 14;
export const CLOSED_TEST_TESTERS = 12;

/** Progress of the closed-test period from the first closed release. */
export function closedTestProgress(startedAt: Date | null, now = new Date()) {
  if (!startedAt) return { started: false, daysDone: 0, daysLeft: CLOSED_TEST_DAYS, canApply: false };
  const daysDone = Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 86_400_000));
  const daysLeft = Math.max(0, CLOSED_TEST_DAYS - daysDone);
  return { started: true, daysDone, daysLeft, canApply: daysLeft === 0 };
}
