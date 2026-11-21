const { chromium } = require("playwright");
const session = { access_token: "x.y.z", refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: "22222222-2222-4222-8222-222222222222", aud: "authenticated", role: "authenticated", email: "demo@example.com", app_metadata: {}, user_metadata: {} } };
const val = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
(async () => {
  const b = await chromium.launch(); const c = await b.newContext();
  await c.addCookies([{ name: "sb-localhost-auth-token", value: val, url: "http://localhost:3100" }]);
  const p = await c.newPage();
  p.on("pageerror", (e) => console.log("PAGEERROR", e.message, e.stack?.split("\n").slice(0,3).join(" | ")));
  p.on("console", (m) => m.type() === "error" && console.log("CONSOLE", m.text().slice(0, 300)));
  for (const id of process.argv.slice(2)) { await p.goto(`http://localhost:3100/projects/${id}`); await p.waitForTimeout(2500); console.log("--", id); }
  await b.close();
})();
