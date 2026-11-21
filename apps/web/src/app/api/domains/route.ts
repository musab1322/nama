import { z } from "zod";
import { adminClient } from "@banna/shared/supabase-admin";
import { HttpError, isUniqueViolation, json, parseBody, requireOwnedProject, requireUser, route } from "@/lib/http";
import { normalizeHostname, recordsToShow, verificationToRecords } from "@banna/integrations/domains";
import { addProjectDomain, getDomainConfig, VercelError } from "@banna/integrations/vercel";

export const runtime = "nodejs";

/** GET /api/domains?projectId=… — list (RLS-scoped). */
export const GET = route(async (req) => {
  const { supabase } = await requireUser();
  const projectId = z.string().uuid().parse(new URL(req.url).searchParams.get("projectId"));
  const { data, error } = await supabase
    .from("domains")
    .select("*")
    .eq("project_id", projectId)
    .neq("status", "removed")
    .order("created_at");
  if (error) throw error;
  return json({ domains: data });
});

const Body = z.object({
  projectId: z.string().uuid(),
  hostname: z.string().min(4).max(300),
  /** For an apex domain, also attach www.<apex> redirecting to it. */
  includeWww: z.boolean().default(true),
});

/**
 * POST /api/domains — attach a custom domain.
 * Returns the DNS records the user must add at their registrar.
 */
export const POST = route(async (req) => {
  const { supabase } = await requireUser();
  const body = await parseBody(req, Body);
  const project = await requireOwnedProject(supabase, body.projectId);
  if (!project.vercel_project_id) {
    throw new HttpError(409, "publish_web_first", "Publish the website once before adding a domain");
  }
  const admin = adminClient();
  const hostname = normalizeHostname(body.hostname);

  const attach = async (name: string, redirect?: string) => {
    const { data: row, error } = await admin
      .from("domains")
      .insert({ project_id: project.id, hostname: name, status: "pending", redirect_to: redirect ?? null })
      .select("id")
      .single();
    if (error) {
      if (isUniqueViolation(error)) throw new HttpError(409, "domain_taken", `${name} is already connected`);
      throw error;
    }
    try {
      const added = await addProjectDomain(project.vercel_project_id!, name, redirect);
      const config = await getDomainConfig(name);
      const { data, error: upErr } = await admin
        .from("domains")
        .update({
          is_apex: added.name === added.apexName,
          status: added.verified && !config.misconfigured ? "active" : "verifying",
          dns_records: recordsToShow(name, added.apexName, config),
          verification_records: verificationToRecords(added.apexName, added.verification),
          ssl_status: added.verified && !config.misconfigured ? "issued" : "pending",
          last_checked_at: new Date().toISOString(),
        })
        .eq("id", row.id)
        .select()
        .single();
      if (upErr) throw upErr;
      return data;
    } catch (err) {
      await admin
        .from("domains")
        .update({ status: "error", misconfigured_reason: err instanceof Error ? err.message : "failed" })
        .eq("id", row.id);
      if (err instanceof VercelError) {
        const code = err.code === "domain_already_in_use" ? "domain_in_use_elsewhere" : "domain_rejected";
        throw new HttpError(422, code, err.message);
      }
      throw err;
    }
  };

  const primary = await attach(hostname);
  const extra = [];
  if (body.includeWww && primary.is_apex) {
    try {
      extra.push(await attach(`www.${hostname}`, hostname));
    } catch (err) {
      if (!(err instanceof HttpError && err.code === "domain_taken")) throw err;
    }
  }
  return json({ domains: [primary, ...extra] }, 201);
});
