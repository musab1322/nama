-- T-09 tests. Lines marked EXPECT must fail; every other statement must succeed.
\set VERBOSITY terse
insert into auth.users (id,email) values ('aaaaaaaa-0000-0000-0000-000000000001','a@x.com'),('bbbbbbbb-0000-0000-0000-000000000002','b@x.com');
set role service_role; set request.jwt.claims = '{"role":"service_role"}';
insert into publisher_accounts (kind, owner_id, platform, display_name, play_developer_id) values ('customer','aaaaaaaa-0000-0000-0000-000000000001','android','No type','1'); -- EXPECT play type required
insert into publisher_accounts (kind, owner_id, platform, display_name, play_developer_id, play_account_type, play_account_created_on) values
  ('customer','aaaaaaaa-0000-0000-0000-000000000001','android','New personal','2','personal','2026-10-01'),
  ('customer','aaaaaaaa-0000-0000-0000-000000000001','android','Old personal','3','personal','2022-05-01'),
  ('customer','aaaaaaaa-0000-0000-0000-000000000001','android','Company','4','organization','2026-10-01');
select display_name, public.play_needs_closed_test(id) as closed from publisher_accounts order by play_developer_id; -- t, f, f
update publisher_accounts set play_production_access = true where play_developer_id = '2';
select public.play_needs_closed_test(id) as after_access from publisher_accounts where play_developer_id = '2';   -- f
update publisher_accounts set play_production_access = false where play_developer_id = '2';
reset role;

set role authenticated; set request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002"}';
select public.play_needs_closed_test((select id from publisher_accounts limit 1)) as other_user;   -- f (sees nothing)
reset role;
set role authenticated; set request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
select count(*) as own_visible, bool_or(play_account_type = 'personal') as type_visible from publisher_accounts;  -- 3, t
update publisher_accounts set play_production_access = true;                                     -- EXPECT denied (server only)
reset role;
