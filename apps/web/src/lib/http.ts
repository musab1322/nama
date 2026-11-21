import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { HttpError, isUniqueViolation, type OwnedProject } from "@banna/shared/errors";
import { userClient } from "@/lib/supabase/server";

export { HttpError, isUniqueViolation, type OwnedProject };

export function json<T>(data: T, status = 200) {
  return NextResponse.json(data, { status });
}

type Handler<C> = (req: Request, ctx: C) => Promise<Response>;

/** Wraps a route handler: typed errors → JSON, unknown errors → 500 without leaking internals. */
export function route<C = unknown>(handler: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
      }
      if (err instanceof ZodError) {
        return json({ error: { code: "invalid_request", message: "Invalid request", details: err.issues } }, 400);
      }
      console.error("[api] unhandled error", err);
      return json({ error: { code: "internal_error", message: "Something went wrong" } }, 500);
    }
  };
}

export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError(400, "invalid_json", "Body must be JSON");
  }
  return schema.parse(raw);
}

export async function requireUser(): Promise<{ user: User; supabase: SupabaseClient }> {
  const supabase = await userClient();
  // getUser() validates the JWT with Supabase Auth (getSession() would trust the cookie).
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new HttpError(401, "unauthorized", "Sign in required");
  return { user: data.user, supabase };
}

/**
 * Loads the project through the USER's client, so RLS proves ownership.
 * Everything after this may use the admin client for writes.
 */
export async function requireOwnedProject(supabase: SupabaseClient, projectId: string): Promise<OwnedProject> {
  const { data, error } = await supabase
    .from("projects")
    .select("id, owner_id, name, slug, status, current_version_id, vercel_project_id, eas_project_id, app_config")
    .eq("id", projectId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, "project_not_found", "Project not found");
  return data as OwnedProject;
}

