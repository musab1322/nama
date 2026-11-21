\set ON_ERROR_STOP 0
\set VERBOSITY terse
insert into auth.users (id,email,raw_user_meta_data) values
 ('aaaaaaaa-0000-0000-0000-000000000001','a@x.com','{"full_name":"A","locale":"en"}'),
 ('bbbbbbbb-0000-0000-0000-000000000002','b@x.com','{"name":"B"}');
select id, locale, credits_balance from profiles order by email;

-- A creates a project
set role authenticated; set request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}';
insert into projects (name, slug) values ('Shop','shop-app') returning owner_id;
insert into projects (name, slug, vercel_project_id) values ('X','x-app','prj_x');         -- EXPECT permission denied
insert into projects (owner_id, name, slug) values ('bbbbbbbb-0000-0000-0000-000000000002','X','x-app2'); -- EXPECT RLS violation
insert into project_versions (project_id, storage_path, content_hash) select id,'p',repeat('a',64) from projects; -- EXPECT denied
update profiles set credits_balance = 9999;                                               -- EXPECT denied
update profiles set full_name = 'A2' returning full_name;
reset role; reset request.jwt.claims;

-- B project + versions via service role
set role service_role;
insert into projects (owner_id,name,slug) values ('bbbbbbbb-0000-0000-0000-000000000002','B','b-app');
insert into project_versions (project_id, storage_path, content_hash, source)
  select id, 'p1', repeat('a',64), 'ai_generation' from projects where slug='shop-app';
insert into project_versions (project_id, storage_path, content_hash)
  select id, 'p2', repeat('b',64) from projects where slug='shop-app';
insert into project_versions (project_id, storage_path, content_hash)
  select id, 'pb', repeat('c',64) from projects where slug='b-app';
select p.slug, v.version_number from project_versions v join projects p on p.id=v.project_id order by 1,2;
update project_versions set summary='x';                                                   -- EXPECT append-only error
select public.spend_credits('aaaaaaaa-0000-0000-0000-000000000001', 15, 'gen-1');  -- signup gives 20 (CR-004)
select public.spend_credits('aaaaaaaa-0000-0000-0000-000000000001', 15, 'gen-2');          -- EXPECT insufficient_credits
reset role;

-- A: rollback pointer and isolation
set role authenticated; set request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}';
update projects set current_version_id = (select v.id from project_versions v where version_number=1) where slug='shop-app' returning slug;
select count(*) as a_sees_versions from project_versions;     -- 2
select count(*) as a_sees_projects from projects;             -- 1
select public.spend_credits('aaaaaaaa-0000-0000-0000-000000000001', 1, 'gen-3');          -- EXPECT denied
select public.can_publish_to_stores((select id from projects where slug='shop-app')) as can_publish_before;
reset role; reset request.jwt.claims;
-- cross-tenant pointer must fail at FK level
set role service_role;
update projects set current_version_id = (select v.id from project_versions v join projects p on p.id=v.project_id where p.slug='b-app') where slug='shop-app'; -- EXPECT FK violation
-- mobile pipeline
update projects set store_publishing_unlocked_at = now() where slug='shop-app';
insert into mobile_apps (project_id, platform, bundle_identifier, display_name)
  select id,'ios','app.platform.shop','Shop' from projects where slug='shop-app';
insert into mobile_apps (project_id, platform, bundle_identifier, display_name)
  select id,'android','App.Platform.Bad-Id','Shop' from projects where slug='shop-app';   -- EXPECT check violation
insert into mobile_builds (project_id, mobile_app_id, platform, version_id, app_version, build_number, runtime_version)
  select m.project_id, m.id, 'ios', v.id, '1.0.0', 0, '1.0.0' from mobile_apps m join project_versions v on v.project_id=m.project_id and v.version_number in (1,2);
select build_number from mobile_builds order by 1;
insert into mobile_builds (project_id, mobile_app_id, platform, version_id, app_version, build_number, runtime_version)
  select m.project_id, m.id, 'android', v.id, '1.0.0', 0, '1' from mobile_apps m join project_versions v on v.project_id=m.project_id and v.version_number=1; -- EXPECT FK (platform mismatch)
insert into store_submissions (project_id, mobile_app_id, mobile_build_id, platform, track)
  select b.project_id, b.mobile_app_id, b.id, 'ios', 'production' from mobile_builds b limit 1; -- EXPECT track check
insert into store_submissions (project_id, mobile_app_id, mobile_build_id, platform, track)
  select b.project_id, b.mobile_app_id, b.id, 'ios', 'app_store' from mobile_builds b where build_number=1;
update store_submissions set status='in_review';
update store_submissions set status='rejected', rejection_reason='Guideline 4.2', rejection_guidelines='{4.2}';
select jsonb_array_length(status_history) as history_len from store_submissions;
insert into ota_releases (project_id, version_id, runtime_version)
  select project_id, id, '1.0.0' from project_versions where version_number=2 and storage_path='p2';
reset role;

set role authenticated; set request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}';
select public.can_publish_to_stores((select id from projects where slug='shop-app')) as can_publish_after;
update mobile_apps set display_name='Shop Pro' returning display_name;
update mobile_apps set store_app_id='123';                         -- EXPECT denied
select count(*) a_sees_subs from store_submissions;                -- 1
insert into storage.objects (bucket_id,name) select 'project-assets', id||'/icon.png' from projects where slug='shop-app';
insert into storage.objects (bucket_id,name) values ('project-assets','not-a-uuid/icon.png');  -- EXPECT RLS
delete from projects where slug='shop-app';                        -- EXPECT FK restrict (has mobile app)
reset role; reset request.jwt.claims;

set role authenticated; set request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","role":"authenticated"}';
select count(*) b_sees_versions from project_versions;             -- 1
select count(*) b_sees_subs from store_submissions;                -- 0
select count(*) b_sees_objects from storage.objects;               -- 0
insert into storage.objects (bucket_id,name) select 'project-assets', id||'/x.png' from projects p where false;
delete from projects where slug='b-app' returning slug;            -- OK (cascade, no store app)
reset role; reset request.jwt.claims;

set role anon;
select count(*) from profiles;                                     -- EXPECT denied
reset role;
select count(*) remaining_b_versions from project_versions v where storage_path='pb';
