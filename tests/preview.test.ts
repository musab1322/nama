/**
 * ADR-010 feasibility spike: the generated app's own supabase-js code runs
 * unchanged against PGlite in the preview, with RLS enforced.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { createClient } from "@supabase/supabase-js";
import { setupPreviewDb } from "../templates/expo-base/overlay/src/lib/preview/db";
import { createPreviewFetch } from "../templates/expo-base/overlay/src/lib/preview/rest";

const APP_SQL = `
create table public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null, price_halalas integer not null check (price_halalas > 0),
  created_at timestamptz not null default now()
);
alter table public.products enable row level security;
create policy "products: read all" on public.products for select to anon, authenticated using (true);
grant select on public.products to anon, authenticated;

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  status text not null default 'new', note text,
  created_at timestamptz not null default now()
);
create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  product_id uuid not null references public.products (id),
  quantity integer not null default 1
);
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
create policy "orders: own" on public.orders for all to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "items: own" on public.order_items for all to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and o.owner_id = (select auth.uid())))
  with check (exists (select 1 from public.orders o where o.id = order_id and o.owner_id = (select auth.uid())));
grant select, insert, update, delete on public.orders, public.order_items to authenticated;

create or replace function public.order_total(p_order uuid) returns integer language sql stable as $$
  select coalesce(sum(i.quantity * p.price_halalas), 0)::int from public.order_items i join public.products p on p.id = i.product_id where i.order_id = p_order
$$;
grant execute on function public.order_total(uuid) to authenticated;

create or replace function public.payment_amount_for(p_reference_type text, p_reference_id text, p_user_id uuid) returns integer
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_reference_type <> 'order' then raise exception 'unknown reference'; end if;
  if not exists (select 1 from public.orders where id = p_reference_id::uuid and owner_id = p_user_id) then
    raise exception 'not your order';
  end if;
  return public.order_total(p_reference_id::uuid);
end $$;
create or replace function public.on_payment_paid(p_reference_type text, p_reference_id text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.orders set status = 'paid' where id = p_reference_id::uuid;
end $$;

insert into public.products (name, price_halalas) values ('ورد أحمر', 15000), ('باقة تخرج', 25000);
`;

async function boot() {
  const db = new PGlite({ extensions: { pgcrypto } });
  const base = await readFile(new URL("../templates/expo-base/overlay/supabase/migrations/00000000000000_platform_base.sql", import.meta.url), "utf8");
  const { failures } = await setupPreviewDb(db, [
    { name: "00000000000000_platform_base", sql: base },
    { name: "20261121150000_00_shop", sql: APP_SQL },
  ]);
  assert.deepEqual(failures, []);
  const client = () =>
    createClient("https://preview.local", "preview-key", {
      global: { fetch: createPreviewFetch(db) },
      auth: { persistSession: false, autoRefreshToken: false },
    });
  return { db, client };
}

test("preview: the app's supabase-js code runs on PGlite with RLS", async () => {
  const { client } = await boot();
  const visitor = client();

  const products = await visitor.from("products").select("id, name, price_halalas").order("price_halalas", { ascending: false });
  assert.equal(products.error, null);
  assert.deepEqual(products.data!.map((p) => p.name), ["باقة تخرج", "ورد أحمر"]);

  const anonOrders = await visitor.from("orders").select("*");
  assert.ok(anonOrders.error, "anon has no grant on orders");
  const anonInsert = await visitor.from("products").insert({ name: "x", price_halalas: 1 });
  assert.ok(anonInsert.error);

  const a = client();
  const signUp = await a.auth.signUp({ email: "a@example.com", password: "password-a" });
  assert.equal(signUp.error, null);
  const me = await a.auth.getUser();
  assert.equal(me.data.user?.email, "a@example.com");

  const order = await a.from("orders").insert({ note: "عيد ميلاد" }).select().single();
  assert.equal(order.error, null);
  const [p1, p2] = products.data!;
  const items = await a.from("order_items").insert([
    { order_id: order.data!.id, product_id: p1!.id, quantity: 2 },
    { order_id: order.data!.id, product_id: p2!.id },
  ]).select();
  assert.equal(items.error, null);
  assert.equal(items.data!.length, 2);

  // one level of embedding, filters, count, rpc
  const withItems = await a.from("orders").select("id, note, order_items(quantity, product_id)").eq("id", order.data!.id).single();
  assert.equal(withItems.error, null);
  assert.equal((withItems.data as { order_items: unknown[] }).order_items.length, 2);
  const counted = await a.from("order_items").select("*", { count: "exact" }).gte("quantity", 2);
  assert.equal(counted.count, 1);
  const total = await a.rpc("order_total", { p_order: order.data!.id });
  assert.equal(total.data, 65000);

  // another user sees nothing of A's
  const b = client();
  await b.auth.signUp({ email: "b@example.com", password: "password-b" });
  const bOrders = await b.from("orders").select("*");
  assert.deepEqual(bOrders.data, []);
  const hijack = await b.from("orders").update({ note: "hacked" }).eq("id", order.data!.id).select();
  assert.deepEqual(hijack.data, []);

  // update / delete with filters
  const upd = await a.from("orders").update({ note: "تعديل" }).eq("id", order.data!.id).select().single();
  assert.equal(upd.data?.note, "تعديل");

  // payments: price comes from the database, preview never charges
  const pay = await a.functions.invoke("payments", { body: { action: "create", referenceType: "order", referenceId: order.data!.id } });
  assert.equal(pay.error, null);
  assert.equal(pay.data.status, "paid");
  const bPay = await b.functions.invoke("payments", { body: { action: "create", referenceType: "order", referenceId: order.data!.id } });
  assert.ok(bPay.error, "nobody pays for someone else's order");
  const paid = await a.from("app_payments").select("amount_halalas, status").single();
  assert.deepEqual(paid.data, { amount_halalas: 65000, status: "paid" });
  const after = await a.from("orders").select("status").eq("id", order.data!.id).single();
  assert.equal(after.data?.status, "paid");

  // sign in again, then delete the account: the user's rows go with it
  await a.auth.signOut();
  const signIn = await a.auth.signInWithPassword({ email: "a@example.com", password: "password-a" });
  assert.equal(signIn.error, null);
  const bad = await client().auth.signInWithPassword({ email: "a@example.com", password: "wrong-pass" });
  assert.ok(bad.error);
  const del = await a.functions.invoke("delete-account", { method: "POST" });
  assert.equal(del.error, null);
  const gone = await client().auth.signInWithPassword({ email: "a@example.com", password: "password-a" });
  assert.ok(gone.error);
});

test("preview: privacy consent is stored per notice version and only for oneself", async () => {
  const { client } = await boot();
  const a = client();
  const { data } = await a.auth.signUp({ email: "c@example.com", password: "password-c" });
  const ok = await a.from("privacy_consents").insert({ user_id: data.user!.id, notice_version: "2026-11" });
  assert.equal(ok.error, null);
  const spoof = await a.from("privacy_consents").insert({ user_id: "00000000-0000-0000-0000-000000000001", notice_version: "2026-11" });
  assert.ok(spoof.error);
});

test("preview: a migration that fails is reported, not fatal", async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  const { failures } = await setupPreviewDb(db, [{ name: "bad", sql: "create table x (" }]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.name, "bad");
});
