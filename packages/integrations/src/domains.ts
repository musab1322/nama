import { domainToASCII } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@banna/shared/env";
import { HttpError } from "@banna/shared/errors";
import { getDomainConfig, verifyProjectDomain, type DomainConfig, type ProjectDomain } from "./vercel";

const HOSTNAME_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** "https://WWW.متجري.com/" → "www.xn--mgbaam8a3d.com" */
export function normalizeHostname(input: string): string {
  let host = input.trim().toLowerCase();
  host = host.replace(/^[a-z]+:\/\//, "").split("/")[0]!.split(":")[0]!.replace(/\.$/, "");
  const ascii = domainToASCII(host);
  if (!ascii || ascii.length < 4 || ascii.length > 253 || !HOSTNAME_RE.test(ascii)) {
    throw new HttpError(400, "invalid_domain", "Enter a valid domain such as example.com");
  }
  const root = env().PLATFORM_ROOT_DOMAIN.toLowerCase();
  if (ascii === root || ascii.endsWith(`.${root}`) || ascii.endsWith(".vercel.app")) {
    throw new HttpError(400, "reserved_domain", "This domain is reserved");
  }
  return ascii;
}

export interface DnsRecord {
  type: "A" | "CNAME" | "TXT";
  name: string; // "@" for apex
  value: string;
}

export function recordsToShow(host: string, apexName: string, config: DomainConfig): DnsRecord[] {
  const isApex = host === apexName;
  const label = isApex ? "@" : host.slice(0, -(apexName.length + 1));
  if (isApex) {
    const ips = [...(config.recommendedIPv4 ?? [])].sort((a, b) => a.rank - b.rank)[0]?.value ?? [];
    return ips.map((ip) => ({ type: "A", name: "@", value: ip }));
  }
  const cname = [...(config.recommendedCNAME ?? [])].sort((a, b) => a.rank - b.rank)[0]?.value;
  return cname ? [{ type: "CNAME", name: label, value: cname.replace(/\.$/, "") }] : [];
}

export function verificationToRecords(apexName: string, v: ProjectDomain["verification"]): DnsRecord[] {
  return (v ?? []).map((r) => ({
    type: r.type.toUpperCase() as DnsRecord["type"],
    name: r.domain === apexName ? "@" : r.domain.replace(`.${apexName}`, ""),
    value: r.value,
  }));
}

/**
 * Re-checks a domain with Vercel and stores the result.
 * Vercel issues the TLS certificate automatically once DNS is correct.
 */
export async function refreshDomain(
  admin: SupabaseClient,
  row: { id: string; hostname: string; vercel_project_id: string },
) {
  let verified = false;
  let apexName = row.hostname;
  let verification: ProjectDomain["verification"] = [];
  try {
    const d = await verifyProjectDomain(row.vercel_project_id, row.hostname);
    verified = d.verified;
    apexName = d.apexName;
    verification = d.verification;
  } catch {
    // 400 "domain not verified yet" is expected while DNS propagates.
  }
  const config = await getDomainConfig(row.hostname);
  const active = verified && !config.misconfigured;

  const update = {
    status: active ? "active" : verified ? "misconfigured" : "verifying",
    ssl_status: active ? "issued" : "pending",
    dns_records: recordsToShow(row.hostname, apexName, config),
    verification_records: verificationToRecords(apexName, verification),
    misconfigured_reason: active
      ? null
      : verified
        ? "DNS records do not point to the platform yet"
        : "Ownership verification (TXT) pending",
    last_checked_at: new Date().toISOString(),
    ...(active ? { verified_at: new Date().toISOString() } : {}),
  };
  const { data, error } = await admin.from("domains").update(update).eq("id", row.id).select().single();
  if (error) throw error;
  return data;
}
