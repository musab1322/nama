-- T-05 tests. Lines marked EXPECT must fail; every other statement must succeed.
\set VERBOSITY terse
insert into auth.users (id,email) values ('aaaaaaaa-0000-0000-0000-000000000001','a@x.com'),('bbbbbbbb-0000-0000-0000-000000000002','b@x.com');
set role service_role;
insert into projects (owner_id,name,slug) values ('aaaaaaaa-0000-0000-0000-000000000001','Shop','shop-app');
update profiles set credits_balance = 10 where id = 'aaaaaaaa-0000-0000-0000-000000000001';
update profiles set credits_balance = 0  where id = 'bbbbbbbb-0000-0000-0000-000000000002';

-- start_spec_draft: owner only, one at a time, charges once
select public.start_spec_draft((select id from projects where slug='shop-app'), 'bbbbbbbb-0000-0000-0000-000000000002', 1, '{}'); -- EXPECT project_not_found
select public.start_spec_draft((select id from projects where slug='shop-app'), 'aaaaaaaa-0000-0000-0000-000000000001', 1, '{"prompt":"x"}') > 0 as queued;
select public.start_spec_draft((select id from projects where slug='shop-app'), 'aaaaaaaa-0000-0000-0000-000000000001', 1, '{"prompt":"x"}'); -- EXPECT draft_in_progress
select credits_balance as balance_after_draft from profiles where id='aaaaaaaa-0000-0000-0000-000000000001';      -- 9
select kind, payload ? 'creditRef' as has_ref, max_attempts from jobs;                                          -- spec.draft, t, 3
update jobs set status = 'succeeded';

-- the worker inserts drafts
insert into app_specs (project_id, content, markdown) select id, '{"goal":"v1"}', '# v1' from projects where slug='shop-app';
insert into app_specs (project_id, content, markdown) select id, '{"goal":"v2"}', '# v2' from projects where slug='shop-app';

-- approve_spec
select public.approve_spec((select id from app_specs where spec_number=1), 'bbbbbbbb-0000-0000-0000-000000000002', 5); -- EXPECT spec_not_found (not owner)
select public.approve_spec((select id from app_specs where spec_number=1), 'aaaaaaaa-0000-0000-0000-000000000001', 50); -- EXPECT insufficient_credits
select count(*) as approved_after_failed from app_specs where status='approved';                               -- 0 (rolled back)
select public.approve_spec((select id from app_specs where spec_number=1), 'aaaaaaaa-0000-0000-0000-000000000001', 5) > 0 as generate_queued;
select (select current_spec_id from projects) = (select id from app_specs where spec_number=1) as pointer_set;   -- t
select credits_balance as balance_after_approve from profiles where id='aaaaaaaa-0000-0000-0000-000000000001';  -- 4
select public.approve_spec((select id from app_specs where spec_number=2), 'aaaaaaaa-0000-0000-0000-000000000001', 1); -- EXPECT generation_in_progress
update jobs set status = 'succeeded';
select public.approve_spec((select id from app_specs where spec_number=1), 'aaaaaaaa-0000-0000-0000-000000000001', 1); -- EXPECT spec_locked
select public.approve_spec((select id from app_specs where spec_number=2), 'aaaaaaaa-0000-0000-0000-000000000001', 1) > 0 as second_queued;
select spec_number, status from app_specs order by spec_number;                                                -- 1 superseded, 2 approved
select (select current_spec_id from projects) = (select id from app_specs where spec_number=2) as pointer_moved; -- t
select count(*) as generate_jobs, count(distinct payload->>'specId') as distinct_specs from jobs where kind='app.generate'; -- 2, 2
reset role;

-- clients cannot call either function
set role authenticated; set request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
select public.start_spec_draft((select id from projects), 'aaaaaaaa-0000-0000-0000-000000000001', 0, '{}');    -- EXPECT denied
select public.approve_spec(gen_random_uuid(), 'aaaaaaaa-0000-0000-0000-000000000001', 0);                    -- EXPECT denied
reset role;
