-- CR-004 tests. Lines marked EXPECT must fail; every other statement must succeed.
-- Checks use `assert`, so a wrong value is an unexpected error.
\set VERBOSITY terse
insert into auth.users (id,email) values ('aaaaaaaa-0000-0000-0000-000000000001','a@x.com'),('bbbbbbbb-0000-0000-0000-000000000002','b@x.com');
set role service_role; set request.jwt.claims = '{"role":"service_role"}';

do $$ begin
  assert (select price_halalas from plans where code='basic') = 14900, 'basic price';
  assert (select price_halalas from plans where code='pro') = 29900, 'pro price';
  assert (select max_published_apps from plans where code='pro') = 2, 'pro apps';
  assert (select monthly_credits from plans where code='pro') = 200, 'pro credits';
  assert (select price_halalas from plans where code='extra_app') = 12900, 'extra app price';
  assert (select credits_balance from profiles where id='aaaaaaaa-0000-0000-0000-000000000001') = 20, 'signup credits';
end $$;

-- charity: 20% off
insert into organizations (owner_id, kind, legal_name, license_number, verification_status) values ('bbbbbbbb-0000-0000-0000-000000000002','charity','جمعية','77','verified');
do $$ begin
  assert public.plan_price_for('bbbbbbbb-0000-0000-0000-000000000002', (select id from plans where code='basic')) = 11920, 'charity basic';
  assert public.plan_price_for('aaaaaaaa-0000-0000-0000-000000000001', (select id from plans where code='basic')) = 14900, 'business basic';
end $$;

-- no plan: no slot
insert into projects (id, owner_id, name, slug) values
  ('cccccccc-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','A','app-one'),
  ('cccccccc-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','B','app-two'),
  ('cccccccc-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000001','C','app-three');
select public.claim_publish_slot('cccccccc-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001');   -- EXPECT app_limit_reached

-- basic: one slot, idempotent for the same app
insert into payments (id, user_id, purpose, plan_id, amount_halalas) values
  ('11111111-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','subscription',(select id from plans where code='basic'),14900);
select public.settle_platform_payment('11111111-0000-0000-0000-000000000001','pay_1', 14900, 'tok');
do $$ begin
  assert public.claim_publish_slot('cccccccc-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001') = 'claimed', 'first slot';
  assert public.claim_publish_slot('cccccccc-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001') = 'already_published', 'same app';
end $$;
select public.claim_publish_slot('cccccccc-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001');   -- EXPECT app_limit_reached
select public.claim_publish_slot('cccccccc-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000002');   -- EXPECT project_not_found (not the owner)

-- buy an extra app: one more slot, renewal includes it
insert into payments (id, user_id, purpose, plan_id, amount_halalas) values
  ('11111111-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','extra_app',(select id from plans where code='extra_app'),12900);
do $$ begin
  assert public.settle_platform_payment('11111111-0000-0000-0000-000000000002','pay_2', 12900, null) = 'extra_app_added', 'addon settled';
  assert public.publish_limit_for('aaaaaaaa-0000-0000-0000-000000000001') = 2, 'limit with addon';
  assert public.claim_publish_slot('cccccccc-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001') = 'claimed', 'addon slot';
end $$;
update subscriptions set next_charge_at = now() - interval '1 minute';
do $$ begin
  assert (select amount from public.due_renewals(10)) = 14900 + 12900, 'renewal includes addon';
end $$;

-- cannot drop the addon while both apps are published; archiving one frees it
select public.remove_extra_app('aaaaaaaa-0000-0000-0000-000000000001');   -- EXPECT apps_over_limit
update projects set status = 'archived' where id = 'cccccccc-0000-0000-0000-000000000002';
do $$ begin
  assert public.remove_extra_app('aaaaaaaa-0000-0000-0000-000000000001') = 0, 'addon removed';
  assert (select amount from public.due_renewals(10)) = 14900, 'renewal without addon';
end $$;
select public.remove_extra_app('aaaaaaaa-0000-0000-0000-000000000001');   -- EXPECT no_extra_app

-- an addon paid with no live plan is kept for a manual refund
insert into payments (id, user_id, purpose, plan_id, amount_halalas) values
  ('11111111-0000-0000-0000-000000000003','bbbbbbbb-0000-0000-0000-000000000002','extra_app',(select id from plans where code='extra_app'),10320);
do $$ begin
  assert public.settle_platform_payment('11111111-0000-0000-0000-000000000003','pay_3', 10320, null) = 'extra_app_orphaned', 'orphan addon';
end $$;
reset role;

-- users cannot claim slots, touch published_at or extra_apps
set role authenticated; set request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
select public.claim_publish_slot('cccccccc-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000001');   -- EXPECT denied
update projects set published_at = null where id = 'cccccccc-0000-0000-0000-000000000001';                          -- EXPECT denied
update subscriptions set extra_apps = 9;                                                                              -- EXPECT denied
reset role;
