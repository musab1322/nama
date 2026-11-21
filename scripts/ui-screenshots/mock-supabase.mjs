import http from "node:http";
const P = "11111111-1111-4111-8111-111111111111";
const U = "22222222-2222-4222-8222-222222222222";
const V = (n) => `00000000-0000-4000-8000-00000000000${n}`;
const now = Date.now();
const iso = (minAgo) => new Date(now - minAgo * 60000).toISOString();
const user = { id: U, aud: "authenticated", role: "authenticated", email: "demo@example.com", app_metadata: {}, user_metadata: {}, created_at: iso(9999) };
const tables = {
  profiles: [{ id: U, credits_balance: 42 }],
  projects: [{ id: P, name: "متجر ورد الرياض", slug: "app-ward-riyadh", status: "ready", current_version_id: V(3), vercel_project_id: "prj_x", updated_at: iso(5), icon_path: null,
    web_deployments: [{ status: "ready", alias_url: null, created_at: iso(6) }], store_submissions: [{ status: "in_review", platform: "ios", created_at: iso(60) }, { status: "published", platform: "android", created_at: iso(120) }] },
    { id: "33333333-3333-4333-8333-333333333333", name: "حجوزات صالون", slug: "app-salon", status: "draft", current_version_id: null, vercel_project_id: null, updated_at: iso(300), web_deployments: [], store_submissions: [] }],
  project_versions: [
    { id: V(1), project_id: P, version_number: 1, prompt: "متجر ورد في الرياض مع سلة شراء وتسجيل دخول وتتبع الطلبات", summary: "بنيت متجراً فيه: الصفحة الرئيسية، قائمة الورود، السلة، الدفع عند الاستلام، تسجيل الدخول، وتتبع الطلبات. أنشأت قاعدة بيانات للمنتجات والطلبات.", source: "ai", created_at: iso(90) },
    { id: V(2), project_id: P, version_number: 2, prompt: "غيّر اللون الأساسي إلى الأخضر وأضف صفحة عن المتجر", summary: "غيّرت اللون الأساسي إلى أخضر زيتي وأضفت صفحة «عن المتجر» في القائمة.", source: "ai", created_at: iso(40) },
    { id: V(3), project_id: P, version_number: 3, prompt: "أضف قسم العروض في الصفحة الرئيسية", summary: "أضفت شريط عروض في أعلى الصفحة الرئيسية مع خصم على باقات المناسبات.", source: "ai", created_at: iso(6) }],
  web_deployments: [
    { id: "d1", project_id: P, version_id: V(3), target: "preview", status: "ready", url: "http://localhost:54321/demo-app", alias_url: null, created_at: iso(5) },
    { id: "d2", project_id: P, version_id: V(2), target: "production", status: "ready", url: "http://localhost:54321/demo-app", alias_url: "app-ward-riyadh.banna.app", created_at: iso(30) }],
  app_backends: [{ id: "b1", project_id: P, status: "active", last_error: null }],
  backend_migrations: [],
  domains: [{ id: "dm1", project_id: P, hostname: "wardriyadh.com", is_apex: true, redirect_to: null, status: "verifying", ssl_status: "pending", misconfigured_reason: null,
    verification_records: [], dns_records: [{ type: "A", name: "@", value: "76.76.21.21" }], created_at: iso(20) },
    { id: "dm2", project_id: P, hostname: "www.wardriyadh.com", is_apex: false, redirect_to: "wardriyadh.com", status: "active", ssl_status: "issued", misconfigured_reason: null, verification_records: [], dns_records: [{ type: "CNAME", name: "www", value: "cname.vercel-dns.com" }], created_at: iso(20) }],
  mobile_apps: [{ id: "ma1", project_id: P, platform: "ios", bundle_identifier: "app.banna.appwardriyadh", display_name: "ورد الرياض", subtitle: "ورد وهدايا بتوصيل سريع", short_description: "اطلب أجمل الورود في الرياض مع توصيل في نفس اليوم", full_description: "", keywords: "ورد,هدايا,الرياض", category: "shopping", privacy_policy_url: null, icon_path: null },
    { id: "ma2", project_id: P, platform: "android", bundle_identifier: "app.banna.appwardriyadh", display_name: "ورد الرياض", subtitle: null, short_description: "", full_description: "", keywords: null, category: "shopping", privacy_policy_url: null, icon_path: null }],
  mobile_builds: [{ id: "mb1", project_id: P, platform: "ios", status: "finished", app_version: "1.0.0", build_number: 3, error_message: null, created_at: iso(70) },
    { id: "mb2", project_id: P, platform: "android", status: "finished", app_version: "1.0.0", build_number: 2, error_message: null, created_at: iso(130) }],
  store_submissions: [
    { id: "s1", project_id: P, platform: "ios", mobile_build_id: "mb1", status: "in_review", track: "app_store", store_url: null, rejection_reason: null, created_at: iso(60),
      status_history: [{ status: "queued", at: iso(70), reason: null }, { status: "submitting", at: iso(50), reason: null }, { status: "submitted", at: iso(45), reason: null }, { status: "in_review", at: iso(10), reason: null }] },
    { id: "s2", project_id: P, platform: "android", mobile_build_id: "mb2", status: "published", track: "production", store_url: "https://play.google.com/store/apps/details?id=app.banna.appwardriyadh", rejection_reason: null, created_at: iso(120),
      status_history: [{ status: "queued", at: iso(130), reason: null }, { status: "submitted", at: iso(110), reason: null }, { status: "in_review", at: iso(100), reason: null }, { status: "published", at: iso(20), reason: null }] }],
  publisher_accounts: process.env.NO_APPLE ? [] : [],
};
const demo = `<!doctype html><html lang="ar" dir="rtl"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{margin:0;font-family:system-ui;background:#f7f5f0;color:#1d2b22}header{background:#2f5d46;color:#fff;padding:18px 16px;font-weight:700;font-size:20px}
.promo{margin:12px;padding:14px;border-radius:14px;background:#f3d9c9;color:#7a3b1d}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;padding:12px}
.c{background:#fff;border-radius:14px;padding:10px;box-shadow:0 1px 3px #0001}.img{height:110px;border-radius:10px;background:linear-gradient(135deg,#e8a5a5,#f6d3b3)}
.p{font-weight:600;margin-top:8px}.pr{color:#2f5d46}nav{position:fixed;bottom:0;inset-inline:0;display:flex;justify-content:space-around;background:#fff;padding:12px;border-top:1px solid #ddd}
</style><header>ورد الرياض 🌷</header><div class="promo">عروض المناسبات: خصم 20٪ على باقات التخرج</div><div class="grid">
${["باقة جوري","ورد أبيض","توليب هولندي","باقة التخرج","أوركيد","ورد مجفف"].map(n=>`<div class="c"><div class="img"></div><div class="p">${n}</div><div class="pr">١٨٠ ر.س</div></div>`).join("")}</div><nav><span>الرئيسية</span><span>السلة</span><span>طلباتي</span><span>حسابي</span></nav></html>`;
http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*", "Access-Control-Expose-Headers": "*" };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (url.pathname === "/demo-app") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(demo); }
  if (url.pathname === "/auth/v1/user") { res.writeHead(200, { ...cors, "Content-Type": "application/json" }); return res.end(JSON.stringify(user)); }
  const m = url.pathname.match(/^\/rest\/v1\/(\w+)/);
  if (m) {
    let rows = tables[m[1]] ?? [];
    for (const [k, v] of url.searchParams) {
      const eq = /^eq\.(.*)$/.exec(v);
      if (eq && !["select", "order", "limit"].includes(k) && rows[0] && k in rows[0] && typeof rows[0][k] !== "object") rows = rows.filter((r) => String(r[k]) === eq[1]);
    }
    const single = (req.headers.accept || "").includes("vnd.pgrst.object");
    res.writeHead(single && !rows.length ? 406 : 200, { ...cors, "Content-Type": "application/json", "Content-Range": `0-${rows.length}/${rows.length}` });
    return res.end(JSON.stringify(single ? rows[0] ?? { code: "PGRST116", message: "no rows" } : rows));
  }
  res.writeHead(404, cors); res.end("{}");
}).listen(54321, () => console.log("mock on 54321"));
