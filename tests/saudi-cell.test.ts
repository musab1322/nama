import { test } from "node:test";
import assert from "node:assert/strict";
import { saudiCellProvider, CellControlError, type CellTransport } from "@banna/backends/saudi-cell";
import { saudiCellConfigured } from "@banna/backends/provider";

test("Saudi cell provider speaks the cell-control contract", async () => {
  const calls: string[] = [];
  const transport: CellTransport = async (method, path, body) => {
    calls.push(`${method} ${path}`);
    if (method === "POST" && path === "/cells/apps") {
      // a retried job: the app already exists, 409 carries it
      return { status: 409, json: { id: "app_1", name: (body as { name: string }).name, apiUrl: "https://app-1.cell.example.sa", status: "creating" } };
    }
    if (path === "/cells/apps/app_1") return { status: 200, json: { id: "app_1", apiUrl: "x", name: "n", status: "ready" } };
    if (path.endsWith("/configure")) return { status: 200, json: { publishable: "pk", secret: "sk" } };
    if (path.endsWith("/security")) return { status: 200, json: { errors: ["rls_disabled_in_public:orders"] } };
    if (path.endsWith("/secrets")) return { status: 400, json: { error: { code: "bad_secret", message: "no" } } };
    return { status: 204, json: null };
  };
  const p = saudiCellProvider(transport);
  assert.deepEqual(await p.create({ name: "app-shop", dbPassword: "pw", region: null, instanceSize: null }), { ref: "app_1", apiUrl: "https://app-1.cell.example.sa" });
  assert.equal(await p.isReady("app_1"), true);
  assert.deepEqual(await p.configure("app_1", { siteUrl: "https://s", redirectUrls: [] }), { publishable: "pk", secret: "sk" });
  assert.deepEqual(await p.securityErrors("app_1"), ["rls_disabled_in_public:orders"]);
  await p.applyMigration("app_1", "001", "select 1");
  await assert.rejects(p.setSecret("app_1", "MOYASAR_SECRET_KEY", "sk_test_x"), (e: unknown) => e instanceof CellControlError && e.code === "bad_secret");
  await assert.rejects(p.setSecret("app_1", "SUPABASE_URL", "x"), /invalid secret name/);
  await p.suspend("app_1");
  assert.deepEqual(calls.slice(-1), ["POST /cells/apps/app_1/suspend"]);
});

test("the cell counts as configured only with URL, certificate and key", () => {
  assert.equal(saudiCellConfigured({}), false);
  assert.equal(saudiCellConfigured({ CELL_CONTROL_URL: "https://c", CELL_CLIENT_CERT: "c" }), false);
  assert.equal(saudiCellConfigured({ CELL_CONTROL_URL: "https://c", CELL_CLIENT_CERT: "c", CELL_CLIENT_KEY: "k" }), true);
});
