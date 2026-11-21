/**
 * A PostgREST + GoTrue stand-in for the preview (ADR-010). It is passed to
 * supabase-js as `global.fetch`, so the generated app's code is exactly the code
 * that runs in production; only the transport differs.
 *
 * Supported: select (columns, one level of embedding by foreign key), filters
 * eq/neq/gt/gte/lt/lte/like/ilike/is/in, order, limit/offset, count, single;
 * insert / upsert / update / delete with return=representation; rpc;
 * email+password sign-up/sign-in, user, logout; the delete-account and payments
 * functions. Everything runs under the caller's role, so RLS applies as in production.
 */
import type { PreviewDb, PreviewTx } from "./db";

type Row = Record<string, unknown>;
type Tx = PreviewTx;

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const qi = (name: string) => {
  if (!IDENT.test(name)) throw new PreviewError(400, "PGRST100", `invalid identifier: ${name}`);
  return `"${name}"`;
};

export class PreviewError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const OPS: Record<string, string> = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "like", ilike: "ilike" };
const RESERVED_PARAMS = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

function b64url(s: string) {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string) {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return decodeURIComponent(escape(atob(pad)));
}

/** Unsigned token in JWT shape: supabase-js only reads it; nothing here is a security boundary. */
export function previewToken(user: { id: string; email: string | null }) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const body = b64url(JSON.stringify({ sub: user.id, email: user.email, role: "authenticated", aud: "authenticated", iat: now, exp: now + 3600 * 24 }));
  return `${header}.${body}.preview`;
}

function claimsFrom(headers: Headers): Row | null {
  const auth = headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(fromB64url(parts[1]!)) as Row;
    return claims.sub ? claims : null;
  } catch {
    return null;
  }
}

/** WHERE clause from PostgREST-style query params. */
function buildWhere(params: URLSearchParams, values: unknown[], prefix = "") {
  const clauses: string[] = [];
  for (const [key, raw] of params) {
    if (RESERVED_PARAMS.has(key) || key.includes(".")) continue;
    const col = `${prefix}${qi(key)}`;
    const negate = raw.startsWith("not.");
    const expr = negate ? raw.slice(4) : raw;
    const dot = expr.indexOf(".");
    const op = expr.slice(0, dot);
    const val = expr.slice(dot + 1);
    let clause: string;
    if (op in OPS) {
      values.push(val);
      clause = `${col} ${OPS[op]} $${values.length}`;
    } else if (op === "is") {
      const v = val.toLowerCase();
      if (!["null", "true", "false"].includes(v)) throw new PreviewError(400, "PGRST100", `bad is value: ${val}`);
      clause = `${col} is ${v}`;
    } else if (op === "in") {
      const items = val.replace(/^\(|\)$/g, "").split(",").map((x) => x.replace(/^"|"$/g, ""));
      values.push(items);
      clause = `${col}::text = any($${values.length}::text[])`;
    } else {
      throw new PreviewError(400, "PGRST100", `operator not supported in preview: ${op}`);
    }
    clauses.push(negate ? `not (${clause})` : clause);
  }
  return clauses.length ? ` where ${clauses.join(" and ")}` : "";
}

/** select=a,b,author:profiles(name),items(*) → SQL list with one level of embedding. */
async function buildSelect(tx: Tx, table: string, select: string | null) {
  const parts = splitTop(select ?? "*");
  const cols: string[] = [];
  for (const part of parts) {
    const m = part.match(/^(?:([A-Za-z_][A-Za-z0-9_]*):)?([A-Za-z_][A-Za-z0-9_]*)(?:!inner)?\((.*)\)$/);
    if (!m) {
      const [name, alias] = part.includes(":") ? part.split(":").reverse() : [part, null];
      cols.push(name === "*" ? `t.*` : alias ? `t.${qi(name!)} as ${qi(alias)}` : `t.${qi(name!)}`);
      continue;
    }
    const [, alias, rel, inner] = m;
    const innerCols = splitTop(inner || "*").map((c) => (c === "*" ? "r.*" : `r.${qi(c)}`)).join(", ");
    const fk = await findForeignKey(tx, table, rel!);
    const sub =
      fk.direction === "to_one"
        ? `(select row_to_json(x) from (select ${innerCols} from public.${qi(rel!)} r where r.${qi(fk.refColumn)} = t.${qi(fk.column)}) x)`
        : `coalesce((select json_agg(row_to_json(x)) from (select ${innerCols} from public.${qi(rel!)} r where r.${qi(fk.column)} = t.${qi(fk.refColumn)}) x), '[]'::json)`;
    cols.push(`${sub} as ${qi(alias ?? rel!)}`);
  }
  return cols.join(", ");
}

function splitTop(s: string) {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s.replace(/\s+/g, "")) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

async function findForeignKey(tx: Tx, table: string, rel: string) {
  // pg_catalog, not information_schema: the latter hides constraints from non-owner roles
  const q = `
    select src.relname as src, sa.attname as col, dst.relname as dst, da.attname as refcol
      from pg_constraint c
      join pg_class src on src.oid = c.conrelid
      join pg_class dst on dst.oid = c.confrelid
      join pg_namespace n on n.oid = src.relnamespace and n.nspname = 'public'
      join pg_attribute sa on sa.attrelid = c.conrelid and sa.attnum = c.conkey[1]
      join pg_attribute da on da.attrelid = c.confrelid and da.attnum = c.confkey[1]
     where c.contype = 'f' and array_length(c.conkey, 1) = 1
       and ((src.relname = $1 and dst.relname = $2) or (src.relname = $2 and dst.relname = $1))`;
  const { rows } = await tx.query<{ src: string; col: string; dst: string; refcol: string }>(q, [table, rel]);
  const r = rows[0];
  if (!r) throw new PreviewError(400, "PGRST200", `no relationship between ${table} and ${rel}`);
  return r.src === table
    ? { direction: "to_one" as const, column: r.col, refColumn: r.refcol }
    : { direction: "to_many" as const, column: r.col, refColumn: r.refcol };
}

function orderBy(params: URLSearchParams) {
  const order = params.get("order");
  if (!order) return "";
  return (
    " order by " +
    order
      .split(",")
      .map((o) => {
        const [col, ...mods] = o.split(".");
        const dir = mods.includes("desc") ? "desc" : "asc";
        const nulls = mods.includes("nullsfirst") ? " nulls first" : mods.includes("nullslast") ? " nulls last" : "";
        return `t.${qi(col!)} ${dir}${nulls}`;
      })
      .join(", ")
  );
}

function limitOffset(params: URLSearchParams) {
  const limit = params.get("limit");
  const offset = params.get("offset");
  return `${limit ? ` limit ${Number.parseInt(limit, 10)}` : ""}${offset ? ` offset ${Number.parseInt(offset, 10)}` : ""}`;
}

async function asRole<T>(db: PreviewDb, claims: Row | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${claims ? "authenticated" : "anon"}`);
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims ?? { role: "anon" })]);
    return fn(tx);
  });
}

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

function pgError(err: unknown) {
  if (err instanceof PreviewError) return jsonResponse(err.status, { code: err.code, message: err.message, details: null, hint: null });
  const e = err as { code?: string; message?: string };
  const status = e.code === "42501" ? 403 : e.code === "23505" ? 409 : e.code?.startsWith("23") ? 400 : 400;
  return jsonResponse(status, { code: e.code ?? "PGRST000", message: e.message ?? String(err), details: null, hint: null });
}

async function handleRest(db: PreviewDb, url: URL, init: RequestInit, headers: Headers) {
  const claims = claimsFrom(headers);
  const path = url.pathname.replace(/^\/rest\/v1\//, "");
  const params = url.searchParams;
  const prefer = headers.get("prefer") ?? "";
  const wantsObject = (headers.get("accept") ?? "").includes("vnd.pgrst.object");
  const method = (init.method ?? "GET").toUpperCase();
  const body = init.body ? (JSON.parse(String(init.body)) as Row | Row[]) : null;

  return asRole(db, claims, async (tx) => {
    if (path.startsWith("rpc/")) {
      const fn = qi(path.slice(4));
      const args = (method === "GET" ? Object.fromEntries(params) : (body as Row)) ?? {};
      const names = Object.keys(args);
      const sql = `select * from public.${fn}(${names.map((n, i) => `${qi(n)} => $${i + 1}`).join(", ")})`;
      const { rows, fields } = await tx.query<Row>(sql, names.map((n) => args[n]));
      // scalar functions come back as one column named after the function
      const scalar = fields.length === 1 && fields[0]!.name === path.slice(4);
      const out = scalar ? (rows[0]?.[fields[0]!.name] ?? null) : rows;
      return jsonResponse(200, out);
    }

    const table = qi(path);
    const values: unknown[] = [];
    const where = buildWhere(params, values, "t.");
    const returning = prefer.includes("return=representation");

    if (method === "GET" || method === "HEAD") {
      const cols = await buildSelect(tx, path, params.get("select"));
      const { rows } = await tx.query<Row>(`select ${cols} from public.${table} t${where}${orderBy(params)}${limitOffset(params)}`, values);
      const extra: Record<string, string> = {};
      if (prefer.includes("count=")) {
        const c = await tx.query<{ n: number }>(`select count(*)::int as n from public.${table} t${where}`, values);
        extra["Content-Range"] = `0-${Math.max(rows.length - 1, 0)}/${c.rows[0]!.n}`;
      }
      if (wantsObject) {
        if (rows.length !== 1) return jsonResponse(406, { code: "PGRST116", message: `JSON object requested, ${rows.length} rows returned` });
        return jsonResponse(200, rows[0], extra);
      }
      return jsonResponse(200, method === "HEAD" ? null : rows, extra);
    }

    if (method === "POST") {
      const list = Array.isArray(body) ? body : [body ?? {}];
      if (!list.length) return jsonResponse(201, []);
      const cols = [...new Set(list.flatMap((r) => Object.keys(r)))];
      const vals: unknown[] = [];
      const tuples = list.map((r) => `(${cols.map((c) => (c in r ? (vals.push(toPg(r[c])), `$${vals.length}`) : "default")).join(", ")})`);
      let conflict = "";
      const onConflict = params.get("on_conflict");
      if (prefer.includes("resolution=merge-duplicates") || prefer.includes("resolution=ignore-duplicates")) {
        const target = onConflict ? `(${onConflict.split(",").map(qi).join(", ")})` : await primaryKeyTarget(tx, path);
        conflict = prefer.includes("ignore-duplicates")
          ? ` on conflict ${target} do nothing`
          : ` on conflict ${target} do update set ${cols.map((c) => `${qi(c)} = excluded.${qi(c)}`).join(", ")}`;
      }
      const sql = `insert into public.${table} as t (${cols.map(qi).join(", ")}) values ${tuples.join(", ")}${conflict}${returning ? " returning *" : ""}`;
      const { rows } = await tx.query<Row>(sql, vals);
      return returnRows(rows, returning, wantsObject, 201);
    }

    if (method === "PATCH") {
      const patch = (body ?? {}) as Row;
      const keys = Object.keys(patch);
      if (!keys.length) return jsonResponse(204, null);
      const sets = keys.map((k) => (values.push(toPg(patch[k])), `${qi(k)} = $${values.length}`));
      const sql = `update public.${table} as t set ${sets.join(", ")}${where}${returning ? " returning *" : ""}`;
      const { rows } = await tx.query<Row>(sql, values);
      return returnRows(rows, returning, wantsObject, 200);
    }

    if (method === "DELETE") {
      const { rows } = await tx.query<Row>(`delete from public.${table} as t${where}${returning ? " returning *" : ""}`, values);
      return returnRows(rows, returning, wantsObject, 200);
    }
    throw new PreviewError(405, "PGRST105", `method ${method} not supported`);
  });
}

const toPg = (v: unknown) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v);

function returnRows(rows: Row[], returning: boolean, wantsObject: boolean, status: number) {
  if (!returning) return jsonResponse(status === 201 ? 201 : 204, null);
  if (wantsObject) return rows.length === 1 ? jsonResponse(status, rows[0]) : jsonResponse(406, { code: "PGRST116", message: "JSON object requested" });
  return jsonResponse(status, rows);
}

async function primaryKeyTarget(tx: Tx, table: string) {
  const { rows } = await tx.query<{ col: string }>(
    `select a.attname as col from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = ('public.' || quote_ident($1))::regclass and i.indisprimary`,
    [table],
  );
  return `(${rows.map((r) => qi(r.col)).join(", ")})`;
}

// ---------------------------------------------------------------- auth (GoTrue subset)

async function handleAuth(db: PreviewDb, url: URL, init: RequestInit, headers: Headers) {
  const path = url.pathname.replace(/^\/auth\/v1\//, "");
  const body = init.body ? (JSON.parse(String(init.body)) as Row) : {};
  const session = (u: { id: string; email: string | null; raw_user_meta_data?: unknown; created_at?: unknown }) => {
    const user = {
      id: u.id,
      aud: "authenticated",
      role: "authenticated",
      email: u.email,
      user_metadata: u.raw_user_meta_data ?? {},
      app_metadata: { provider: "email" },
      created_at: u.created_at ?? new Date().toISOString(),
    };
    return {
      access_token: previewToken(u),
      token_type: "bearer",
      expires_in: 86400,
      expires_at: Math.floor(Date.now() / 1000) + 86400,
      refresh_token: `preview:${u.id}`,
      user,
    };
  };

  if (path === "signup") {
    const email = String(body.email ?? "").toLowerCase();
    const password = String(body.password ?? "");
    if (!email.includes("@") || password.length < 8) return jsonResponse(422, { code: "validation_failed", msg: "Email and a password of 8+ characters are required" });
    try {
      const { rows } = await db.query<{ id: string; email: string; raw_user_meta_data: unknown; created_at: string }>(
        `insert into auth.users (email, encrypted_password, raw_user_meta_data) values ($1, crypt($2, gen_salt('bf', 4)), $3) returning id, email, raw_user_meta_data, created_at`,
        [email, password, JSON.stringify((body.data as Row) ?? {})],
      );
      return jsonResponse(200, session(rows[0]!));
    } catch (err) {
      if ((err as { code?: string }).code === "23505") return jsonResponse(422, { code: "user_already_exists", msg: "User already registered" });
      throw err;
    }
  }
  if (path === "token") {
    const grant = url.searchParams.get("grant_type");
    if (grant === "password") {
      const { rows } = await db.query<{ id: string; email: string; raw_user_meta_data: unknown; created_at: string }>(
        `select id, email, raw_user_meta_data, created_at from auth.users where email = lower($1) and encrypted_password = crypt($2, encrypted_password)`,
        [String(body.email ?? ""), String(body.password ?? "")],
      );
      if (!rows[0]) return jsonResponse(400, { error: "invalid_grant", error_description: "Invalid login credentials", code: "invalid_credentials" });
      return jsonResponse(200, session(rows[0]));
    }
    if (grant === "refresh_token") {
      const id = String(body.refresh_token ?? "").replace(/^preview:/, "");
      const { rows } = await db.query<{ id: string; email: string; raw_user_meta_data: unknown; created_at: string }>(
        `select id, email, raw_user_meta_data, created_at from auth.users where id::text = $1`,
        [id],
      );
      if (!rows[0]) return jsonResponse(400, { error: "invalid_grant", code: "refresh_token_not_found" });
      return jsonResponse(200, session(rows[0]));
    }
  }
  if (path === "user") {
    const claims = claimsFrom(headers);
    if (!claims) return jsonResponse(401, { code: "no_authorization", msg: "Not signed in" });
    const { rows } = await db.query<{ id: string; email: string; raw_user_meta_data: unknown; created_at: string }>(
      `select id, email, raw_user_meta_data, created_at from auth.users where id = $1`,
      [claims.sub],
    );
    if (!rows[0]) return jsonResponse(403, { code: "user_not_found", msg: "User not found" });
    return jsonResponse(200, session(rows[0]).user);
  }
  if (path === "logout") return jsonResponse(204, null);
  return jsonResponse(400, { code: "preview_unsupported", msg: `Not available in the preview: ${path}` });
}

// ---------------------------------------------------------------- functions

async function handleFunction(db: PreviewDb, url: URL, init: RequestInit, headers: Headers) {
  const name = url.pathname.replace(/^\/functions\/v1\//, "");
  const claims = claimsFrom(headers);
  if (name === "delete-account") {
    if (!claims) return jsonResponse(401, { error: "Unauthorized" });
    await db.query(`delete from auth.users where id = $1`, [claims.sub]);
    return jsonResponse(200, { deleted: true });
  }
  if (name === "payments") {
    // Preview never charges anyone: every payment succeeds instantly with demo money.
    if (!claims) return jsonResponse(401, { error: "Unauthorized" });
    const body = init.body ? (JSON.parse(String(init.body)) as Row) : {};
    if (body.action === "create") {
      const { rows } = await db.transaction(async (tx) => {
        const amount = await tx.query<{ amount: number }>(`select public.payment_amount_for($1, $2, $3) as amount`, [body.referenceType, body.referenceId, claims.sub]);
        return tx.query<{ id: string }>(
          `insert into public.app_payments (user_id, reference_type, reference_id, amount_halalas, status, provider_ref)
           values ($1, $2, $3, $4, 'paid', 'preview') returning id`,
          [claims.sub, body.referenceType, body.referenceId, amount.rows[0]!.amount],
        );
      });
      await db.query(`select public.on_payment_paid($1, $2)`, [body.referenceType, body.referenceId]);
      return jsonResponse(200, { paymentId: rows[0]!.id, url: null, status: "paid", preview: true });
    }
    if (body.action === "verify") {
      const { rows } = await db.query<{ status: string }>(`select status from public.app_payments where id = $1 and user_id = $2`, [body.paymentId, claims.sub]);
      return jsonResponse(200, { status: rows[0]?.status ?? "failed" });
    }
  }
  return jsonResponse(404, { error: `function ${name} is not available in the preview` });
}

/** fetch implementation for createClient(url, key, { global: { fetch } }). */
export function createPreviewFetch(db: PreviewDb): typeof fetch {
  return async (input, init = {}) => {
    const req = input instanceof Request ? input : null;
    const url = new URL(req ? req.url : String(input));
    const headers = new Headers(init.headers ?? req?.headers);
    const merged: RequestInit = { ...init, method: init.method ?? req?.method, body: init.body ?? (req ? await req.text() : undefined) };
    if (merged.body === "") merged.body = undefined;
    try {
      if (url.pathname.startsWith("/rest/v1/")) return await handleRest(db, url, merged, headers);
      if (url.pathname.startsWith("/auth/v1/")) return await handleAuth(db, url, merged, headers);
      if (url.pathname.startsWith("/functions/v1/")) return await handleFunction(db, url, merged, headers);
      return jsonResponse(404, { message: "Not available in the preview" });
    } catch (err) {
      return pgError(err);
    }
  };
}
