import { request } from "node:https";
import { env } from "@banna/shared/env";
import type { CellApp, CellKeys, CellSecurity, CellStats } from "./cell-contract";
import { ProviderUnavailableError, assertSecretName, type BackendProvider } from "./provider";

/**
 * Saudi mode (FR-017, design §3.3): app backends inside the in-Kingdom cell,
 * driven through cell-control over mutual TLS. Until the cell exists (first paid
 * request, ADR-002) the CELL_* settings are empty and every call says so.
 */

export class CellControlError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

const pem = (v: string) => v.replace(/\\n/g, "\n");

export interface CellTransport {
  (method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }>;
}

/** Default transport: HTTPS with a client certificate, and the cell's own CA when given. */
export const mtlsTransport: CellTransport = (method, path, body) => {
  const e = env();
  if (!e.CELL_CONTROL_URL || !e.CELL_CLIENT_CERT || !e.CELL_CLIENT_KEY) {
    throw new ProviderUnavailableError("The Saudi cell is not set up yet");
  }
  const url = new URL(path, e.CELL_CONTROL_URL);
  if (url.protocol !== "https:") throw new Error("CELL_CONTROL_URL must be https");
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method,
        cert: pem(e.CELL_CLIENT_CERT!),
        key: pem(e.CELL_CLIENT_KEY!),
        ca: e.CELL_CA_CERT ? pem(e.CELL_CA_CERT) : undefined,
        headers: payload
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
          : {},
        timeout: 60_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = { error: { code: "invalid_response", message: text.slice(0, 200) } };
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("cell-control timed out")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
};

export function saudiCellProvider(transport: CellTransport = mtlsTransport): BackendProvider {
  async function call<T>(method: string, path: string, body?: unknown, okConflict = false): Promise<T> {
    const { status, json } = await transport(method, path, body);
    if (status >= 200 && status < 300) return json as T;
    if (okConflict && status === 409) return json as T;
    const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
    throw new CellControlError(status, err?.code ?? "cell_error", err?.message ?? `cell-control ${status}`, json);
  }
  const app = (ref: string) => `/cells/apps/${encodeURIComponent(ref)}`;

  return {
    mode: "saudi",

    async create(input) {
      // a retried job gets the app it already created (409 carries it)
      const created = await call<CellApp>("POST", "/cells/apps", { name: input.name, dbPassword: input.dbPassword, size: input.instanceSize }, true);
      if (!created?.id || !created.apiUrl) throw new CellControlError(409, "name_taken", "Cell app name is taken");
      return { ref: created.id, apiUrl: created.apiUrl };
    },

    async isReady(ref) {
      const a = await call<CellApp>("GET", app(ref));
      if (a.status === "error") throw new CellControlError(500, "cell_app_error", "The cell could not create this app");
      return a.status === "ready";
    },

    configure: (ref, input) => call<CellKeys>("POST", `${app(ref)}/configure`, input),

    async applyMigration(ref, name, sql) {
      await call("POST", `${app(ref)}/migrations`, { name, sql });
    },

    async deployFunction(ref, name, source, opts) {
      if (!/^[a-z][a-z0-9-]{1,40}$/.test(name)) throw new Error(`invalid function name: ${name}`);
      await call("POST", `${app(ref)}/functions`, { name, source, verifyJwt: opts.verifyJwt });
    },

    async securityErrors(ref) {
      return (await call<CellSecurity>("GET", `${app(ref)}/security`)).errors;
    },

    async setSecret(ref, name, value) {
      assertSecretName(name);
      await call("POST", `${app(ref)}/secrets`, { name, value });
    },

    async suspend(ref) {
      await call("POST", `${app(ref)}/suspend`);
    },
    async resume(ref) {
      await call("POST", `${app(ref)}/resume`);
    },
    async destroy(ref) {
      await call("DELETE", app(ref));
    },
    stats: (ref) => call<CellStats>("GET", `${app(ref)}/stats`),
  };
}
