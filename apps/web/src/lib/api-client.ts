"use client";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Calls our own API routes (cookies carry the session). Throws ApiError with the server's error code. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: init.body ? { "Content-Type": "application/json" } : undefined,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string; details?: unknown } };
  if (!res.ok) {
    throw new ApiError(res.status, data.error?.code ?? "http_error", data.error?.message ?? res.statusText, data.error?.details);
  }
  return data as T;
}
