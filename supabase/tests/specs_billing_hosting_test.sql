-- T-02 tests. Lines marked EXPECT must fail; every other statement must succeed.
\set VERBOSITY terse
insert into auth.users (id,email) values ('aaaaaaaa-0000-0000-0000-000000000001','a@x.com'),('bbbbbbbb-0000-0000-0000-000000000002','b@x.com');
set role service_role;
insert into projects (owner_id,name,slug) values ('aaaaaaaa-0000-0000-0000-000000000001','Shop','shop-app');
insert into projects (owner_id,name,slug) values ('bbbbbbbb-0000-0000-0000-000000000002','Other','other-app');

-- publishers: platform accounts are gone (FR-006a)
insert into publisher_accounts (kind, platform, display_name, play_developer_id) values ('platform','android','Platform','123'); -- EXPECT check violation
insert into publisher_accounts (kind, owner_id, platform, display_name) values ('customer','aaaaaaaa-0000-0000-0000-000000000001','android','A'); -- EXPECT google fields
insert into publisher_accounts (kind, owner_id, platform, display_name, play_developer_id, play_account_type) values ('customer','aaaaaaaa-0000-0000-0000-000000000001','android','A Play','5551234','personal');

-- specs: numbering, single approved, immutability
insert into app_specs (project_id, content, markdown) select id, '{"goal":"x"}', '# v1' from projects where slug='shop-app';
insert into app_specs (project_id, content, markdown) select id, '{"goal":"y"}', '# v2' from projects where slug='shop-app';
select spec_number from app_specs order by spec_number;                        -- 1, 2
update app_specs set content = '{"goal":"x2"}' where spec_number = 1;          -- drafts are editable
update app_specs set status='approved', approved_at=now() where spec_number = 1;
update app_specs set status='approved', approved_at=now() where spec_number = 2;  -- EXPECT unique (one approved)
update app_specs set content = '{"goal":"hack"}' where spec_number = 1;        -- EXPECT immutable
update app_specs set status='approved' where spec_number = 2;                  -- EXPECT approval check (approved_at null)
update app_specs set status='superseded' where spec_number = 1;
update app_specs set status='approved', approved_at=now() where spec_number = 2;
update projects p set current_spec_id = s.id from app_specs s where s.spec_number = 2 and p.slug='shop-app';
update projects p set current_spec_id = (select id from app_specs where spec_number=2) where p.slug='other-app';  -- EXPECT fk (spec from another project)

-- organizations
insert into organizations (owner_id, kind, legal_name, donations_eligible) values ('aaaaaaaa-0000-0000-0000-000000000001','business','A Co', true); -- EXPECT donations only for verified charity
insert into organizations (owner_id, kind, legal_name, license_number) values ('aaaaaaaa-0000-0000-0000-000000000001','charity','جمعية البر','1234');
update organizations set verification_status='verified', donations_eligible=true;
update projects set organization_id = (select id from organizations) where slug='other-app';  -- EXPECT 42501 (B using A's org)
update projects set organization_id = (select id from organizations), category='charity' where slug='shop-app';

-- plans seeded
select code, price_halalas/100 as sar from plans order by sort_order;

-- backends: mode check
insert into app_backends (project_id, hosting, status) select id, 'saudi', 'active' from projects where slug='shop-app';  -- EXPECT mode check
insert into app_backends (project_id, hosting, status, organization_slug) select id, 'standard', 'active', 'apps-org' from projects where slug='shop-app';

-- hosting requests: one open per project
insert into hosting_requests (project_id) select id from projects where slug='shop-app';
insert into hosting_requests (project_id) select id from projects where slug='shop-app';   -- EXPECT unique open
insert into hosting_requests (project_id, region) select id, 'ae' from projects where slug='other-app'; -- EXPECT region check

-- payment accounts
insert into app_payment_accounts (project_id, publishable_key) select id, 'sk_live_abc' from projects where slug='shop-app'; -- EXPECT secret key rejected
insert into app_payment_accounts (project_id, publishable_key) select id, 'pk_test_abc123' from projects where slug='shop-app';

-- audit log append-only
insert into audit_log (actor_id, action, target_type, target_id) values ('aaaaaaaa-0000-0000-0000-000000000001','project.suspend','project','x');
update audit_log set action = 'project.resume';                               -- EXPECT append-only
delete from audit_log;                                                        -- EXPECT append-only
insert into reports (project_id, reason) select id, 'fraud' from projects where slug='shop-app';
reset role;

-- ---------------------------------------------------------------- as user A
set role authenticated; set request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
select count(*) as a_specs from app_specs;                                     -- 2
select count(*) as a_orgs from organizations;                                  -- 1
select count(*) as plans_visible from plans;                                   -- 4
select count(*) as a_payment_accounts from app_payment_accounts;               -- 1
select count(*) from audit_log;                                                -- EXPECT denied
select count(*) from reports;                                                  -- EXPECT denied
insert into app_specs (project_id, content, markdown) select id, '{}', 'x' from projects;     -- EXPECT denied (server only)
update projects set current_spec_id = null;                                    -- EXPECT denied (server only column)
update projects set category = 'store' where slug='shop-app';
update profiles set role = 'admin';                                            -- EXPECT denied
select private.is_admin() as a_is_admin;                                       -- false
insert into organizations (owner_id, kind, legal_name, verification_status) values ('aaaaaaaa-0000-0000-0000-000000000001','charity','X','verified'); -- EXPECT denied (column)
insert into organizations (owner_id, kind, legal_name) values ('bbbbbbbb-0000-0000-0000-000000000002','business','Spoof');  -- EXPECT RLS
insert into organizations (owner_id, kind, legal_name) values ('aaaaaaaa-0000-0000-0000-000000000001','business','A Trading'); -- EXPECT denied (T-13: organizations are written by the server only)
reset role;

-- ---------------------------------------------------------------- as user B
set role authenticated; set request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002"}';
select count(*) as b_specs from app_specs;                                     -- 0
select count(*) as b_orgs from organizations;                                  -- 0
select count(*) as b_payment_accounts from app_payment_accounts;               -- 0
select count(*) as b_hosting from hosting_requests;                            -- 0
reset role;

-- ---------------------------------------------------------------- anon
set role anon;
select count(*) as anon_plans from plans;                                      -- 4
select count(*) from app_specs;                                                -- EXPECT denied
reset role;

-- admin flag + profile deletion keeps audit rows
update profiles set role='admin' where id='aaaaaaaa-0000-0000-0000-000000000001';
set role authenticated; set request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
select private.is_admin() as a_is_admin_now;                                   -- true
reset role;
-- versions + ledger + approved spec referencing B must not block deleting B
insert into project_versions (project_id, storage_path, content_hash, created_by, spec_id)
  select p.id, 'x', repeat('a',64), 'bbbbbbbb-0000-0000-0000-000000000002', s.id from projects p, app_specs s where p.slug='shop-app' and s.spec_number=2;
update project_versions set prompt = 'tamper';                                -- EXPECT append-only
insert into app_specs (project_id, content, markdown, created_by) select id, '{}', 'b', 'bbbbbbbb-0000-0000-0000-000000000002' from projects where slug='other-app';
update app_specs set status='approved', approved_at=now(), approved_by='bbbbbbbb-0000-0000-0000-000000000002' where markdown='b';
delete from credit_transactions;                                               -- EXPECT append-only
delete from auth.users where id='bbbbbbbb-0000-0000-0000-000000000002';
select count(created_by) as versions_creator_nulled, count(*) as versions_kept from project_versions;  -- 0, 1
insert into audit_log (actor_id, action, target_type) values ('aaaaaaaa-0000-0000-0000-000000000001','user.delete','profile');
delete from projects where owner_id='aaaaaaaa-0000-0000-0000-000000000001';    -- EXPECT restrict (app_backends exists)
delete from app_backends; delete from auth.users where id='aaaaaaaa-0000-0000-0000-000000000001';
select count(*) as specs_left, (select count(*) from credit_transactions) as ledger_left from app_specs;   -- 0, 0
select count(*) as audit_rows_kept, count(actor_id) as actors_nulled_to from audit_log;   -- 2, 0
