-- T-15 tests. Lines marked EXPECT must fail; every other statement must succeed.
\set VERBOSITY terse
insert into auth.users (id,email) values ('aaaaaaaa-0000-0000-0000-000000000001','a@x.com'),('cccccccc-0000-0000-0000-000000000003','admin@x.com');
update profiles set role = 'admin' where id = 'cccccccc-0000-0000-0000-000000000003';
insert into projects (owner_id, name, slug) values ('aaaaaaaa-0000-0000-0000-000000000001','App','adm-app');
insert into app_backends (project_id, hosting, organization_slug, region_code, status, supabase_project_ref)
  select id, 'standard', 'org', 'apac', 'active', 'abcdefghijklmnopqrst' from projects;
set role service_role; set request.jwt.claims = '{"role":"service_role"}';

select public.admin_suspend_project((select id from projects), 'aaaaaaaa-0000-0000-0000-000000000001', 'x');   -- EXPECT forbidden
select public.admin_suspend_project((select id from projects), 'cccccccc-0000-0000-0000-000000000003', ' ');   -- EXPECT reason_required
select public.admin_suspend_project((select id from projects), 'cccccccc-0000-0000-0000-000000000003', 'fraud report') as s; -- suspending
select kind, payload ->> 'reason' as reason from jobs;                                                       -- backend.suspend admin
select public.admin_unsuspend_project((select id from projects), 'cccccccc-0000-0000-0000-000000000003', 'cleared', true) as u; -- unsuspended (backend still active in this test)
select public.admin_unsuspend_project((select id from projects), 'cccccccc-0000-0000-0000-000000000003', 'again', true);   -- EXPECT not_suspended
update app_backends set status = 'paused';
select public.admin_suspend_project((select id from projects), 'cccccccc-0000-0000-0000-000000000003', 'again') as s2;   -- suspended
select public.admin_unsuspend_project((select id from projects), 'cccccccc-0000-0000-0000-000000000003', 'ok', true) as u2; -- resuming

select public.admin_grant_credits('aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000003', 20, '') ; -- EXPECT reason_required
select public.admin_grant_credits('aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000003', -100000, 'x'); -- EXPECT invalid_amount
select (select credits_balance from profiles where id='aaaaaaaa-0000-0000-0000-000000000001') as before_grant;
select public.admin_grant_credits('aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000003', 20, 'support case') as after_grant; -- before + 20

select public.submit_report('nope', null, 'fraud', 'x');                                                     -- EXPECT project_not_found
select public.submit_report('adm-app', 'R@x.com', 'fraud', 'fake shop') as r1, public.submit_report('adm-app', 'r@x.com', 'fraud', '2') as r2,
       public.submit_report('adm-app', 'r@x.com', 'fraud', '3') as r3, public.submit_report('adm-app', 'r@x.com', 'fraud', '4') as r4; -- t t t f
select public.submit_report('adm-app', null, 'nonsense', 'x');                                              -- EXPECT check constraint
select public.admin_handle_report((select id from reports order by created_at limit 1), 'cccccccc-0000-0000-0000-000000000003', 'actioned', 'suspended');
select public.admin_handle_report((select id from reports order by created_at limit 1), 'cccccccc-0000-0000-0000-000000000003', 'open', null); -- EXPECT invalid_status

select (o ->> 'users')::int as users, (o ->> 'open_reports')::int as open_reports, o -> 'backends' as backends from public.admin_overview() o; -- 2 2 {"paused":1}
select array_agg(action order by id) from audit_log;
-- {project.suspend,project.unsuspend,project.suspend,project.unsuspend,user.credits,report.actioned}

set role authenticated; set request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}';
update projects set suspended_at = null;                                                                     -- EXPECT denied (admin only column)
select public.admin_overview();                                                                              -- EXPECT denied
select public.submit_report('adm-app', null, 'fraud', 'x');                                                  -- EXPECT denied (server only)
