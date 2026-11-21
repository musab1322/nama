const { chromium } = require("playwright");
const OUT = process.argv[2] || process.env.OUT || __dirname + "/shots";
const P = "11111111-1111-4111-8111-111111111111";
const SALON = "33333333-3333-4333-8333-333333333333";
const session = { access_token: "x.y.z", refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: "22222222-2222-4222-8222-222222222222", aud: "authenticated", role: "authenticated", email: "demo@example.com", app_metadata: {}, user_metadata: {} } };
const val = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
const review = { issues: [], approvable: true, findings: [
  { code: "payments_services", severity: "warning", platforms: ["ios", "android"], ar: "دفع العربون مقابل خدمة تُقدَّم خارج التطبيق مسموح عبر Moyasar، ولا يلزم الشراء داخل التطبيق.", en: "A deposit for a service delivered outside the app may use Moyasar; in-app purchase is not required." },
  { code: "account_deletion", severity: "warning", platforms: ["ios"], ar: "التطبيق ينشئ حسابات، فيجب أن يتيح حذف الحساب من داخله (مضمّن في القالب).", en: "The app creates accounts, so it must offer account deletion inside the app (included in the template)." }] };
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  async function ctx(locale, viewport = { width: 1440, height: 900 }) {
    const c = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    await c.addCookies([{ name: "sb-localhost-auth-token", value: val, url: "http://localhost:3100" }, { name: "locale", value: locale, url: "http://localhost:3100" }]);
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(`${locale}: ${e.message}`));
    p.on("console", (m) => m.type() === "error" && !/WebSocket|realtime|Failed to load resource/i.test(m.text()) && errors.push(`${locale} console: ${m.text()}`));
    await p.route(/\/api\/specs\/[0-9a-f-]+$/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(review) }));
    await p.route(/cdn\.moyasar\.com/, (r) => r.abort());
    return p;
  }
  const shot = (p, n, fullPage = false) => p.screenshot({ path: `${OUT}/${n}.png`, fullPage });
  const wait = (p, ms = 900) => p.waitForTimeout(ms);

  let p = await ctx("ar");
  await p.goto(`http://localhost:3100/projects/${SALON}`); await wait(p, 2000); await shot(p, "20-spec-review-ar");
  await p.goto("http://localhost:3100/billing?status=paid"); await wait(p); await shot(p, "21-billing-ar", true);
  await p.goto("http://localhost:3100/settings"); await wait(p); await shot(p, "22-settings-ar");
  await p.getByRole("button", { name: "حذف الحساب" }).click(); await wait(p, 500); await shot(p, "23-delete-account-ar"); await p.keyboard.press("Escape");
  await p.goto("http://localhost:3100/admin"); await wait(p, 1500); await shot(p, "24-admin-overview-ar");
  await p.getByRole("button", { name: "توثيق الجمعيات" }).click(); await wait(p, 1200); await shot(p, "25-admin-charities-ar");
  await p.goto(`http://localhost:3100/projects/${P}`); await wait(p, 1500);
  await p.getByRole("button", { name: "الإعدادات" }).last().click(); await wait(p, 800); await shot(p, "26-app-settings-payments-ar");
  await p.getByRole("radio", { name: /الاستضافة/ }).click(); await wait(p, 800); await shot(p, "27-app-settings-hosting-ar");
  await p.keyboard.press("Escape");
  await p.route(/rest\/v1\/(store_submissions|mobile_builds|publisher_accounts)/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]", headers: { "Access-Control-Allow-Origin": "*" } }));
  await p.reload(); await wait(p, 1500);
  await p.getByRole("button", { name: /نشر على أندرويد/ }).click(); await wait(p, 1200);
  await p.getByRole("button", { name: "التالي" }).click(); await wait(p, 800); await shot(p, "28-store-google-ar");
  await p.keyboard.press("Escape");

  p = await ctx("ar", { width: 390, height: 844 });
  await p.goto("http://localhost:3100/report/app-ward-riyadh"); await wait(p); await shot(p, "29-report-mobile-ar");
  p = await ctx("en");
  await p.goto(`http://localhost:3100/projects/${SALON}`); await wait(p, 2000); await shot(p, "30-spec-review-en");
  await p.goto("http://localhost:3100/billing"); await wait(p); await shot(p, "31-billing-en", true);
  console.log(errors.length ? errors.join("\n") : "no page errors");
  await browser.close();
})();
