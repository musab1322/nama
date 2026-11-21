import { env } from "@banna/shared/env";

/**
 * Moyasar API for the platform's own billing (FR-012). Card data never reaches
 * our servers: the browser form talks to Moyasar with the publishable key, and
 * the server only reads payments and charges saved tokens with the secret key.
 */
const API = "https://api.moyasar.com/v1";

export class MoyasarError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface MoyasarPayment {
  id: string;
  status: "initiated" | "paid" | "authorized" | "failed" | "refunded" | "captured" | "voided" | "verified" | "expired";
  amount: number;
  currency: string;
  description: string | null;
  metadata: Record<string, string> | null;
  source: { type: string; token?: string | null; transaction_url?: string | null; message?: string | null } | null;
}

async function call<T>(path: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Basic ${Buffer.from(`${env().MOYASAR_SECRET_KEY}:`).toString("base64")}`,
      ...(init.json !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : {};
  if (!res.ok) throw new MoyasarError(res.status, (data as { message?: string }).message ?? `Moyasar ${res.status}`);
  return data as T;
}

export const fetchPayment = (id: string) => call<MoyasarPayment>(`/payments/${encodeURIComponent(id)}`);

/** Charges a saved card. givenId makes retries idempotent on Moyasar's side. */
export function chargeToken(o: { givenId: string; amount: number; token: string; description: string; metadata: Record<string, string> }) {
  return call<MoyasarPayment>("/payments", {
    method: "POST",
    json: {
      given_id: o.givenId,
      amount: o.amount,
      currency: "SAR",
      description: o.description,
      callback_url: `${env().PLATFORM_APP_URL}/api/billing/return`,
      source: { type: "token", token: o.token },
      metadata: o.metadata,
    },
  });
}

export interface CheckoutConfig {
  publishable_api_key: string;
  amount: number;
  currency: "SAR";
  description: string;
  callback_url: string;
  metadata: Record<string, string>;
  methods: ("creditcard" | "applepay" | "stcpay")[];
  supported_networks: ("mada" | "visa" | "mastercard")[];
  credit_card: { save_card: boolean };
}

/** Options for the Moyasar payment form in the browser. */
export function checkoutConfig(o: { paymentId: string; amount: number; description: string; saveCard: boolean }): CheckoutConfig {
  return {
    publishable_api_key: env().MOYASAR_PUBLISHABLE_KEY,
    amount: o.amount,
    currency: "SAR",
    description: o.description,
    callback_url: `${env().PLATFORM_APP_URL}/api/billing/return?payment=${o.paymentId}`,
    metadata: { payment_id: o.paymentId },
    methods: ["creditcard", "applepay", "stcpay"],
    supported_networks: ["mada", "visa", "mastercard"],
    credit_card: { save_card: o.saveCard },
  };
}

/**
 * Checks an app owner's own secret key (FR-014) without moving money:
 * listing payments needs a valid secret key and nothing else.
 */
export async function verifySecretKey(secretKey: string): Promise<"ok" | "rejected"> {
  const res = await fetch(`${API}/payments?page=1`, {
    headers: { Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString("base64")}` },
  });
  if (res.status === 401 || res.status === 403) return "rejected";
  if (!res.ok) throw new MoyasarError(res.status, `Moyasar ${res.status}`);
  return "ok";
}
