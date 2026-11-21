const { chromium } = require("playwright");
const S = process.argv[2];
const P = "11111111-1111-4111-8111-111111111111";
const session = { access_token: "x.y.z", refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: "22222222-2222-4222-8222-222222222222", aud: "authenticated", role: "authenticated", email: "demo@example.com", app_metadata: {}, user_metadata: {} } };
const val = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  async function ctx(locale, viewport) {
    const c = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    await c.addCookies([{ name: "sb-localhost-auth-token", value: val, url: "http://localhost:3100" }, { name: "locale", value: locale, url: "http://localhost:3100" }]);
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(`${locale}: ${e.message}`));
    p.on("console", (m) => m.type() === "error" && !/WebSocket|realtime|Failed to load resource/i.test(m.text()) && errors.push(`${locale} console: ${m.text()}`));
    return p;
  }
  const shot = (p, n) => p.screenshot({ path: `${S}/shots/${n}.png` });
  const wait = (p, ms = 800) => p.waitForTimeout(ms);

  let p = await ctx("ar", { width: 1440, height: 900 });
  await p.goto("http://localhost:3100/login"); await wait(p); await shot(p, "01-login-ar");
  await p.goto("http://localhost:3100/dashboard"); await wait(p); await shot(p, "02-dashboard-ar");
  await p.goto(`http://localhost:3100/projects/${P}`); await wait(p, 2000); await shot(p, "03-workspace-iphone-ar");
  await p.getByRole("radio", { name: "أندرويد" }).click(); await wait(p, 600); await shot(p, "04-workspace-android-ar");
  await p.getByRole("radio", { name: "سطح المكتب" }).click(); await wait(p, 600); await shot(p, "05-workspace-desktop-ar");
  await p.getByRole("radio", { name: "آيفون" }).click();
  await p.getByRole("button", { name: "جرّبه على جوالك" }).click(); await wait(p, 600); await shot(p, "06-qr-ar");
  await p.getByRole("button", { name: "إغلاق" }).last().click();
  await p.getByRole("button", { name: /النسخ/ }).first().click(); await wait(p); await shot(p, "07-history-ar"); await p.keyboard.press("Escape");
  await p.getByRole("button", { name: /نشر على الويب/ }).click(); await wait(p, 1500); await shot(p, "08-web-ar"); await p.keyboard.press("Escape");
  await p.getByRole("button", { name: /نشر على أندرويد/ }).click(); await wait(p, 1500); await shot(p, "09-store-tracker-ar");
  await p.keyboard.press("Escape");
  await p.getByRole("button", { name: /تحديث التطبيق/ }).click(); await wait(p); await shot(p, "12-ota-ar"); await p.keyboard.press("Escape");

  p = await ctx("en", { width: 1440, height: 900 });
  await p.goto(`http://localhost:3100/projects/${P}`); await wait(p, 2000); await shot(p, "13-workspace-en");
  p = await ctx("ar", { width: 1440, height: 900 });
  await p.route(/rest\/v1\/(store_submissions|mobile_builds|publisher_accounts)/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]", headers: { "Access-Control-Allow-Origin": "*" } }));
  await p.goto(`http://localhost:3100/projects/${P}`); await wait(p, 1500);
  await p.getByRole("button", { name: /نشر على أندرويد/ }).click(); await wait(p, 1200); await shot(p, "10-store-platforms-ar");
  await p.getByRole("button", { name: "التالي" }).click(); await wait(p, 800); await shot(p, "11-store-apple-ar");
  await p.keyboard.press("Escape");
  p = await ctx("en", { width: 1440, height: 900 });
  await p.route(/rest\/v1\/(store_submissions|mobile_builds)/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]", headers: { "Access-Control-Allow-Origin": "*" } }));
  await p.goto(`http://localhost:3100/projects/${P}`); await wait(p, 1500);
  await p.getByRole("button", { name: /Publish to iOS/ }).click(); await wait(p, 1200);
  await p.getByRole("checkbox", { name: /App Store/ }).click();
  await p.getByRole("button", { name: "Next" }).click(); await wait(p); await shot(p, "14-store-listing-en");

  p = await ctx("ar", { width: 390, height: 844 });
  await p.goto(`http://localhost:3100/projects/${P}`); await wait(p, 2000); await shot(p, "15-mobile-chat-ar");
  await p.getByRole("tab", { name: "المعاينة" }).click(); await wait(p, 800); await shot(p, "16-mobile-preview-ar");
  console.log(errors.length ? errors.join("\n") : "no page errors");
  await browser.close();
})();
