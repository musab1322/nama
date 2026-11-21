-- T-11: the app owner's Moyasar secret key (FR-014).
-- It belongs in the app's own backend (an Edge Function secret). If the backend does not
-- exist yet (it is created at the first paid publish), the key waits in the platform Vault
-- and is moved, then deleted here, during provisioning. Users can never read its id.

alter table public.app_payment_accounts
  add column pending_secret_id uuid,
  add column key_mode text check (key_mode in ('test', 'live'));

revoke select on public.app_payment_accounts from authenticated;
grant select (id, project_id, provider, publishable_key, secret_stored_at, status, key_mode, created_at, updated_at)
  on public.app_payment_accounts to authenticated;
