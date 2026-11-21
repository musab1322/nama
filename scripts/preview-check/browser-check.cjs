const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");
const root = path.join(__dirname, "app/dist-preview");
const pgl = "/var/tmp/mono/node_modules/@electric-sql/pglite/dist";
const types = { ".js": "text/javascript", ".html": "text/html", ".wasm": "application/wasm", ".data": "application/octet-stream", ".css": "text/css" };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  let f = path.join(root, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = fs.existsSync(f + ".html") ? f + ".html" : path.join(root, "index.html");
  res.writeHead(200, { "Content-Type": types[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
}).listen(4173, async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("console", (m) => console.log("[console]", m.type(), m.text().slice(0, 200)));
  // jsdelivr is not reachable from this sandbox: serve the same files locally
  await page.route("https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.5.17/dist/**", (route) => {
    const rel = route.request().url().split("/dist/")[1];
    const f = path.join(pgl, rel);
    route.fulfill({ status: 200, body: fs.readFileSync(f), headers: { "Content-Type": types[path.extname(f)] || "application/octet-stream", "Access-Control-Allow-Origin": "*" } });
  });
  const t = Date.now();
  await page.goto("http://localhost:4173/demo");
  await page.waitForFunction(() => document.body.innerText.includes("own_orders") || document.body.innerText.includes("crash"), null, { timeout: 60000 }).catch(() => {});
  console.log("ms", Date.now() - t);
  console.log("RESULT\n" + (await page.innerText("body")));
  await browser.close(); srv.close();
});
