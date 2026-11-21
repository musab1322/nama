import { strToU8, zipSync } from "fflate";
import type { ProjectFiles } from "@banna/shared/snapshots";

/**
 * Code export (FR-016, design §5.8): the app's full source, ready to run anywhere,
 * with no secret inside. User data never passes through here.
 */

const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "Supabase secret key", re: /sb_secret_[A-Za-z0-9_-]{10,}/g },
  { name: "Moyasar secret key", re: /sk_(live|test)_[A-Za-z0-9]{10,}/g },
  { name: "Anthropic API key", re: /sk-ant-[A-Za-z0-9_-]{10,}/g },
  { name: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "service_role JWT", re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]*c2VydmljZV9yb2xl[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+/g },
];

/** Files that never leave the platform: local env files and the preview build's generated config. */
const DROP = [/^\.env(\..*)?$/, /(^|\/)\.env(\..*)?$/, /\.(p8|pem|key|jks|keystore)$/i, /^google-services\.json$/, /^GoogleService-Info\.plist$/];

export interface ExportResult {
  zip: Uint8Array;
  fileCount: number;
  removed: string[];
  redacted: { path: string; kind: string }[];
}

export function buildExport(files: ProjectFiles, meta: { appName: string; slug: string; version: number }): ExportResult {
  const removed: string[] = [];
  const redacted: { path: string; kind: string }[] = [];
  const out: ProjectFiles = {};

  for (const [path, content] of Object.entries(files)) {
    if (DROP.some((re) => re.test(path))) {
      removed.push(path);
      continue;
    }
    let text = content;
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(text)) {
        redacted.push({ path, kind: p.name });
        text = text.replace(p.re, "REMOVED_SECRET");
      }
      p.re.lastIndex = 0;
    }
    out[path] = text;
  }

  const migrations = Object.keys(out)
    .filter((p) => p.startsWith("supabase/migrations/") && p.endsWith(".sql"))
    .sort();
  out["supabase/schema.sql"] =
    `-- ${meta.appName}: complete database schema, in order. Run once on an empty Supabase project.\n\n` +
    migrations.map((p) => `-- ${p}\n${out[p]}`).join("\n\n");
  out[".env.example"] = "EXPO_PUBLIC_SUPABASE_URL=https://YOUR-PROJECT.supabase.co\nEXPO_PUBLIC_SUPABASE_KEY=sb_publishable_...\nEXPO_PUBLIC_APP_OWNER=\nEXPO_PUBLIC_CONTACT_EMAIL=\nEXPO_PUBLIC_DATA_LOCATION=outside\n";
  out["README.md"] = readme(meta, { removed, redacted });

  const zip = zipSync(
    Object.fromEntries(Object.entries(out).map(([p, c]) => [`${meta.slug}/${p}`, strToU8(c)])),
    { level: 6 },
  );
  return { zip, fileCount: Object.keys(out).length, removed, redacted };
}

function readme(meta: { appName: string; version: number }, notes: { removed: string[]; redacted: { path: string; kind: string }[] }) {
  const cleaned = notes.removed.length || notes.redacted.length
    ? `\n> Removed for safety / حُذف للأمان: ${[...notes.removed, ...notes.redacted.map((r) => `${r.path} (${r.kind})`)].join(", ")}\n`
    : "";
  return `# ${meta.appName} (v${meta.version})
${cleaned}
## بالعربية

هذا هو الكود الكامل لتطبيقك (Expo / React Native) للويب وiOS وAndroid. لا يحتوي على أي مفتاح سري ولا على بيانات مستخدميك.

1. ثبّت Node.js 22، ثم نفّذ \`npm install\`.
2. أنشئ مشروعاً في Supabase، ثم شغّل الملف \`supabase/schema.sql\` في محرر SQL مرة واحدة.
3. انسخ \`.env.example\` إلى \`.env\` وضع فيه رابط المشروع والمفتاح العام (publishable).
4. انشر الدالتين في \`supabase/functions\` بأمر \`supabase functions deploy\`، وأضف السر \`MOYASAR_SECRET_KEY\` إن كان تطبيقك يستقبل مدفوعات، و\`APP_SITE_URL\` و\`APP_SCHEME\`.
5. للتشغيل: \`npx expo start\`. لبناء الويب: \`npx expo export --platform web\` (ملفات ثابتة في \`dist/\`).
6. لبناء تطبيقات المتاجر استخدم EAS: \`npx eas build\` بحسابك في Expo.

بيانات مستخدميك موجودة في خلفية تطبيقك الحالية؛ اطلب تصديرها من إعدادات التطبيق في المنصة.

## English

This is your app's complete source code (Expo / React Native) for web, iOS and Android. It contains no secret keys and none of your users' data.

1. Install Node.js 22, then run \`npm install\`.
2. Create a Supabase project and run \`supabase/schema.sql\` once in its SQL editor.
3. Copy \`.env.example\` to \`.env\` and fill in the project URL and publishable key.
4. Deploy the functions in \`supabase/functions\` with \`supabase functions deploy\`; set the secrets \`MOYASAR_SECRET_KEY\` (if the app takes payments), \`APP_SITE_URL\` and \`APP_SCHEME\`.
5. Run with \`npx expo start\`. Build the web app with \`npx expo export --platform web\` (static files in \`dist/\`).
6. Build store apps with EAS: \`npx eas build\` under your own Expo account.

Your users' data stays in your app's current backend; request a data export from the app's settings on the platform.
`;
}
