\set VERBOSITY terse
insert into auth.users (id,email) values ('aaaaaaaa-0000-0000-0000-000000000001','a@x.com'),('bbbbbbbb-0000-0000-0000-000000000002','b@x.com');
set role service_role;
insert into projects (owner_id,name,slug) values ('aaaaaaaa-0000-0000-0000-000000000001','Shop','shop-app');
-- platform iOS publisher must be rejected (4.2.6)
insert into publisher_accounts (kind, platform, display_name, apple_team_id, asc_key_id, asc_issuer_id)
  values ('platform','ios','Platform','ABCDE12345','KEY1234567',gen_random_uuid());              -- EXPECT check violation
insert into publisher_accounts (kind, owner_id, platform, display_name, apple_team_id, asc_key_id, asc_issuer_id, credentials_secret_id)
  values ('customer','aaaaaaaa-0000-0000-0000-000000000001','ios','A Inc','ABCDE12345','KEY1234567',gen_random_uuid(),
          public.vault_store_secret('-----BEGIN PRIVATE KEY-----x','asc:a'));
insert into publisher_accounts (kind, owner_id, platform, display_name, apple_team_id, asc_key_id, asc_issuer_id)
  values ('customer','bbbbbbbb-0000-0000-0000-000000000002','ios','B Inc','ZZZZZ12345','KEY7654321',gen_random_uuid());
insert into publisher_accounts (kind, platform, display_name) values ('platform','android','Platform Play');   -- EXPECT customer-only (T-02)
insert into publisher_accounts (kind, owner_id, platform, display_name, play_developer_id, play_account_type) values ('customer','aaaaaaaa-0000-0000-0000-000000000001','android','Platform Play','5550001','organization');
-- B's publisher on A's app → rejected
insert into mobile_apps (project_id, platform, bundle_identifier, display_name, publisher_account_id)
  select p.id,'ios','app.platform.shop','Shop',(select id from publisher_accounts where display_name='B Inc') from projects p; -- EXPECT 42501
insert into mobile_apps (project_id, platform, bundle_identifier, display_name, publisher_account_id)
  select p.id,'ios','app.platform.shop','Shop',(select id from publisher_accounts where display_name='Platform Play') from projects p; -- EXPECT platform mismatch
insert into mobile_apps (project_id, platform, bundle_identifier, display_name, publisher_account_id)
  select p.id,'ios','app.platform.shop','Shop',(select id from publisher_accounts where display_name='A Inc') from projects p;
insert into mobile_apps (project_id, platform, bundle_identifier, display_name, publisher_account_id)
  select p.id,'android','app.platform.shopa','Shop',(select id from publisher_accounts where display_name='Platform Play') from projects p;
select platform, (select display_name from publisher_accounts x where x.id=m.publisher_account_id) from mobile_apps m order by 1;
select public.vault_read_secret(credentials_secret_id) like '-----BEGIN%' as secret_ok from publisher_accounts where display_name='A Inc';
-- jobs
select public.enqueue_job('mobile.build', '{"a":1}', (select id from projects), 'build:shop') as j1;
select public.enqueue_job('mobile.build', '{"a":2}', (select id from projects), 'build:shop') as j1_again;   -- same id
select id, kind, attempts from public.claim_jobs('w1', array['mobile.build'], 5);
select count(*) as nothing_left from public.claim_jobs('w2', null, 5);
select public.finish_job(1, false, null, 'boom');           -- queued (retry)
select status, attempts, run_after > now() as backoff from jobs;
update jobs set run_after = now() - interval '1s', max_attempts = 2;
select attempts from public.claim_jobs('w1');
select public.finish_job(1, false, null, 'boom again');     -- dead
select public.enqueue_job('mobile.build', '{}', null, 'build:shop') > 1 as new_job_after_dead;
reset role;
set role authenticated; set request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
select display_name, status from publisher_accounts;                     -- only A Inc
select credentials_secret_id from publisher_accounts;                    -- EXPECT denied
select count(*) as a_jobs from jobs;                                     -- EXPECT denied (select * needs all cols)? use explicit cols
select count(id) as a_jobs from jobs;
select public.enqueue_job('x.y.z');                                      -- EXPECT denied
select public.vault_read_secret(gen_random_uuid());                      -- EXPECT denied
