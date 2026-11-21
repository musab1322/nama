-- T-13 tests. Lines marked EXPECT must fail; every other statement must succeed.
\set VERBOSITY terse
insert into auth.users (id,email) values ('aaaaaaaa-0000-0000-0000-000000000001','a@x.com'),('cccccccc-0000-0000-0000-000000000003','admin@x.com');
update profiles set role = 'admin' where id = 'cccccccc-0000-0000-0000-000000000003';
insert into projects (owner_id, name, slug) values ('aaaaaaaa-0000-0000-0000-000000000001','App','org-app');
set role service_role; set request.jwt.claims = '{"role":"service_role"}';

select public.submit_organization('aaaaaaaa-0000-0000-0000-000000000001','charity','جمعية البر', null, 'aaaaaaaa-0000-0000-0000-000000000001/doc.pdf'); -- EXPECT license_required
select public.submit_organization('aaaaaaaa-0000-0000-0000-000000000001','charity','جمعية البر', '123', null);                                           -- EXPECT document_required
select public.submit_organization('aaaaaaaa-0000-0000-0000-000000000001','charity','جمعية البر', '123', 'cccccccc-0000-0000-0000-000000000003/x.pdf'); -- EXPECT invalid_document
select public.submit_organization('aaaaaaaa-0000-0000-0000-000000000001','charity','جمعية البر', '123', 'aaaaaaaa-0000-0000-0000-000000000001/doc.pdf') is not null as submitted;
select verification_status, donations_eligible from organizations;                         -- pending f
select (organization_id is not null) as linked from projects where slug = 'org-app';       -- t
select public.plan_price_for('aaaaaaaa-0000-0000-0000-000000000001', (select id from plans where code='basic')) as pending_price; -- 9900

select public.review_organization((select id from organizations), 'aaaaaaaa-0000-0000-0000-000000000001', true, true, null); -- EXPECT forbidden
select public.review_organization((select id from organizations), 'cccccccc-0000-0000-0000-000000000003', false, false, ''); -- EXPECT note_required
select public.review_organization((select id from organizations), 'cccccccc-0000-0000-0000-000000000003', true, true, 'ok') as decision; -- verified
select verification_status, donations_eligible, reviewed_by is not null as reviewed from organizations;                         -- verified t t
select public.plan_price_for('aaaaaaaa-0000-0000-0000-000000000001', (select id from plans where code='basic')) as charity_price;  -- 4950
select public.review_organization((select id from organizations), 'cccccccc-0000-0000-0000-000000000003', true, true, 'again');  -- EXPECT not_reviewable

-- resubmitting the same facts keeps the decision; a change needs a new review
select public.submit_organization('aaaaaaaa-0000-0000-0000-000000000001','charity','جمعية البر', '123', null) is not null as same;
select verification_status from organizations;                                              -- verified
select public.submit_organization('aaaaaaaa-0000-0000-0000-000000000001','charity','جمعية البر الخيرية', '123', null) is not null as changed;
select verification_status, donations_eligible from organizations;                         -- pending f

-- revoke after verification
select public.review_organization((select id from organizations), 'cccccccc-0000-0000-0000-000000000003', true, false, null);
select public.review_organization((select id from organizations), 'cccccccc-0000-0000-0000-000000000003', false, false, 'licence expired') as revoked; -- rejected
select array_agg(action order by id) as actions from audit_log where target_type = 'organization';
-- {organization.submit,organization.verify,organization.submit,organization.verify,organization.revoke}
select count(*) as orgs from organizations;                                                 -- 1

-- users cannot write organizations directly or call the functions
set role authenticated; set request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}';
insert into organizations (owner_id, kind, legal_name) values ('aaaaaaaa-0000-0000-0000-000000000001','business','X'); -- EXPECT denied
select public.submit_organization('aaaaaaaa-0000-0000-0000-000000000001','business','X', null, null);                   -- EXPECT denied
select verification_status from organizations;                                              -- rejected (reads own)
