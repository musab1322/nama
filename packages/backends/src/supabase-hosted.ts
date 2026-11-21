import { env } from "@banna/shared/env";
import {
  createProject,
  deleteProject,
  deployFunction,
  ensureApiKeys,
  isHealthy,
  pauseProject,
  queryRows,
  restoreProject,
  runMigration,
  securityAdvisors,
  setSecrets,
  updateAuthConfig,
} from "./supabase-management";
import { assertSecretName, type BackendProvider } from "./provider";

/** Standard mode (default): one managed Supabase project per app, created only after payment. */
export const supabaseHostedProvider: BackendProvider = {
  mode: "standard",

  async create(input) {
    const created = await createProject({
      name: input.name,
      dbPass: input.dbPassword,
      regionGroup: input.region ?? env().SUPABASE_APPS_REGION_GROUP,
      instanceSize: input.instanceSize,
    });
    return { ref: created.id, apiUrl: `https://${created.id}.supabase.co` };
  },

  isReady: (ref) => isHealthy(ref),

  async configure(ref, input) {
    const keys = await ensureApiKeys(ref);
    await updateAuthConfig(ref, {
      site_url: input.siteUrl,
      uri_allow_list: input.redirectUrls.join(","),
      external_email_enabled: true,
      mailer_secure_email_change_enabled: true,
      password_min_length: 8,
    });
    return keys;
  },

  applyMigration: (ref, name, sql) => runMigration(ref, name, sql),

  async deployFunction(ref, name, source, opts) {
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(name)) throw new Error(`invalid function name: ${name}`);
    await deployFunction(ref, name, source, opts.verifyJwt);
  },

  async securityErrors(ref) {
    const advisors = await securityAdvisors(ref);
    return advisors.lints.filter((l) => l.level === "ERROR").map((l) => l.name);
  },

  async setSecret(ref, name, value) {
    assertSecretName(name);
    await setSecrets(ref, [{ name, value }]);
  },

  async suspend(ref) {
    await pauseProject(ref);
  },
  async resume(ref) {
    await restoreProject(ref);
  },
  async destroy(ref) {
    await deleteProject(ref);
  },

  async stats(ref) {
    const [row] = await queryRows<{ db: string; storage: string; mau: string }>(
      ref,
      `select pg_database_size(current_database())::text as db,
              (select coalesce(sum((metadata ->> 'size')::bigint), 0) from storage.objects)::text as storage,
              (select count(*) from auth.users where last_sign_in_at > now() - interval '30 days')::text as mau`,
    );
    return {
      dbSizeBytes: Number(row?.db ?? 0),
      storageBytes: Number(row?.storage ?? 0),
      monthlyActiveUsers: Number(row?.mau ?? 0),
      requests24h: null,
    };
  },
};
