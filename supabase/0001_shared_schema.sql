-- =============================================================================
-- Parley — shared multi-merchant schema
--
-- Run this in: Supabase Dashboard → SQL Editor → New query → Run
-- Safe to run on a brand-new empty database, and safe to re-run (idempotent).
--
-- Data minimization decisions baked into this schema:
--   KEEP      ids, timestamps, actor/action/result, reasoning, amounts,
--             currency, mandate caps and spend totals, scalar details keys
--   KEEP      customer_ref (plaintext email) — confirmed decision
--   DROPPED   mandates.note — confirmed decision, column not created
--   DROPPED   details.input wholesale write — enforced in app code
--   NEVER     no Razorpay keys, API keys or bearer tokens are stored;
--             no column here is written from merchant credentials
--
-- IMPORTANT: replace the password on line 105 before running.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Tables
-- -----------------------------------------------------------------------------

create table if not exists public.audit_log (
  id            bigserial   primary key,
  merchant_id   text        not null,
  created_at    timestamptz not null default now(),
  actor         text        not null,
  action        text        not null,
  result        text        not null,
  reasoning     text        not null,
  customer_ref  text,
  amount_minor  bigint,
  currency      text,
  details       jsonb       not null default '{}'::jsonb,

  constraint audit_log_merchant_id_len check (length(merchant_id) between 1 and 200),
  constraint audit_log_actor_valid
    check (actor in ('seller_agent', 'buyer_agent', 'system', 'merchant_api', 'human')),
  constraint audit_log_result_valid
    check (result in ('success', 'blocked', 'failed', 'pending', 'info'))
);

create table if not exists public.mandates (
  id            bigserial   primary key,
  merchant_id   text        not null,
  customer_ref  text        not null,
  cap_minor     bigint      not null,
  spent_minor   bigint      not null default 0,
  currency      text        not null,
  status        text        not null default 'active',
  created_at    timestamptz not null default now(),
  expires_at    timestamptz,

  constraint mandates_merchant_id_len check (length(merchant_id) between 1 and 200),
  constraint mandates_status_valid
    check (status in ('active', 'exhausted', 'expired', 'revoked')),
  constraint mandates_cap_positive     check (cap_minor > 0),
  constraint mandates_spend_positive   check (spent_minor >= 0),
  -- The spending ceiling, enforced by the database itself and not only by the
  -- WHERE clause in application code.
  constraint mandates_spend_within_cap check (spent_minor <= cap_minor)
);

-- Adds merchant_id to a database created by an earlier single-merchant version.
-- No-ops on a fresh database.
alter table public.audit_log add column if not exists merchant_id text;
alter table public.mandates  add column if not exists merchant_id text;
alter table public.mandates  drop column if exists note;

-- -----------------------------------------------------------------------------
-- 2. Indexes — merchant_id leads every one of them
-- -----------------------------------------------------------------------------

create index if not exists audit_log_merchant_created_idx
  on public.audit_log (merchant_id, created_at desc);

create index if not exists audit_log_merchant_customer_idx
  on public.audit_log (merchant_id, customer_ref);

create index if not exists mandates_merchant_customer_idx
  on public.mandates (merchant_id, customer_ref);

-- One active mandate per customer, PER MERCHANT. Two merchants may each hold an
-- active mandate for the same email without colliding.
drop index if exists public.mandates_active_customer_idx;
create unique index if not exists mandates_one_active_per_customer_idx
  on public.mandates (merchant_id, customer_ref)
  where status = 'active';

create index if not exists mandates_expiry_sweep_idx
  on public.mandates (expires_at)
  where status = 'active';

-- -----------------------------------------------------------------------------
-- 3. A role that CANNOT bypass RLS
--
-- This is the part that makes row-level security real. Supabase's default
-- `postgres` role bypasses RLS entirely, so an app connecting as `postgres`
-- gets no protection from the policies below no matter how they are written.
-- The application must connect as this role instead.
-- -----------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'parley_app') then
    -- >>> REPLACE THE PASSWORD BEFORE RUNNING <<<
    create role parley_app login password 'CHANGE_ME_TO_A_LONG_RANDOM_STRING' nobypassrls;
  else
    alter role parley_app nobypassrls;
  end if;
end
$$;

grant usage on schema public to parley_app;

-- Audit log is append-and-read only: no UPDATE, no DELETE.
grant select, insert on public.audit_log to parley_app;
-- Mandates need UPDATE for spend, refund and the expiry sweep. Never DELETE.
grant select, insert, update on public.mandates to parley_app;

grant usage, select on sequence public.audit_log_id_seq to parley_app;
grant usage, select on sequence public.mandates_id_seq  to parley_app;

-- -----------------------------------------------------------------------------
-- 4. Row Level Security
--
-- Every statement is filtered by the merchant_id the connection declares:
--     SET LOCAL parley.merchant_id = '<id>';
--
-- If that setting is absent the comparison yields NULL, which matches no rows.
-- A missed filter in application code therefore returns nothing rather than
-- another merchant's data — it fails closed.
-- -----------------------------------------------------------------------------

alter table public.audit_log enable row level security;
alter table public.mandates  enable row level security;

-- FORCE applies the policies to the table owner too, not just to other roles.
alter table public.audit_log force row level security;
alter table public.mandates  force row level security;

drop policy if exists audit_log_merchant_isolation on public.audit_log;
create policy audit_log_merchant_isolation on public.audit_log
  for all
  to parley_app
  using      (merchant_id = current_setting('parley.merchant_id', true))
  with check (merchant_id = current_setting('parley.merchant_id', true));

drop policy if exists mandates_merchant_isolation on public.mandates;
create policy mandates_merchant_isolation on public.mandates
  for all
  to parley_app
  using      (merchant_id = current_setting('parley.merchant_id', true))
  with check (merchant_id = current_setting('parley.merchant_id', true));

-- -----------------------------------------------------------------------------
-- 5. Backfill and lock down merchant_id
--
-- Existing rows from a single-merchant database are stamped with a placeholder
-- so the NOT NULL can be applied. Re-stamp them afterwards if you care about
-- that history; delete them if you do not.
-- -----------------------------------------------------------------------------

update public.audit_log set merchant_id = 'unassigned' where merchant_id is null;
update public.mandates  set merchant_id = 'unassigned' where merchant_id is null;

alter table public.audit_log alter column merchant_id set not null;
alter table public.mandates  alter column merchant_id set not null;

commit;

-- =============================================================================
-- VERIFICATION — every row must read PASS
-- =============================================================================

with checks as (

  select 1 as ord, 'audit_log table exists' as check_name,
         (to_regclass('public.audit_log') is not null) as ok,
         coalesce(to_regclass('public.audit_log')::text, 'missing') as detail

  union all select 2, 'mandates table exists',
         (to_regclass('public.mandates') is not null),
         coalesce(to_regclass('public.mandates')::text, 'missing')

  union all select 3, 'audit_log.merchant_id is NOT NULL',
         exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='audit_log'
                   and column_name='merchant_id' and is_nullable='NO'),
         'required for isolation'

  union all select 4, 'mandates.merchant_id is NOT NULL',
         exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='mandates'
                   and column_name='merchant_id' and is_nullable='NO'),
         'required for isolation'

  union all select 5, 'mandates.note dropped (data minimization)',
         not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='mandates'
                       and column_name='note'),
         'free-text column must not exist'

  union all select 6, 'no credential-shaped columns anywhere',
         not exists (select 1 from information_schema.columns
                     where table_schema='public'
                       and table_name in ('audit_log','mandates')
                       and (column_name ~* '(secret|password|token|api[_-]?key|authorization|razorpay)')),
         'NEVER STORE list absent from schema'

  union all select 7, 'RLS enabled on both tables',
         (select bool_and(relrowsecurity) from pg_class
          where relname in ('audit_log','mandates')
            and relnamespace = 'public'::regnamespace),
         'enable row level security'

  union all select 8, 'RLS forced on both tables (applies to owner too)',
         (select bool_and(relforcerowsecurity) from pg_class
          where relname in ('audit_log','mandates')
            and relnamespace = 'public'::regnamespace),
         'force row level security'

  union all select 9, 'isolation policy on both tables',
         (select count(*) = 2 from pg_policies
          where schemaname='public'
            and tablename in ('audit_log','mandates')
            and policyname like '%merchant_isolation'),
         'one policy per table'

  union all select 10, 'one-active-mandate index is per merchant',
         exists (select 1 from pg_indexes
                 where schemaname='public' and tablename='mandates'
                   and indexdef like '%merchant_id%customer_ref%'
                   and indexdef like '%status%active%'),
         'prevents cross-merchant collision on the same email'

  union all select 11, 'application role exists and CANNOT bypass RLS',
         exists (select 1 from pg_roles where rolname='parley_app' and rolbypassrls = false),
         'parley_app must be NOBYPASSRLS for policies to mean anything'

  union all select 12, 'application role has no DELETE on audit_log',
         not has_table_privilege('parley_app', 'public.audit_log', 'DELETE'),
         'audit trail is append-only'

  union all select 13, 'role password was changed from the placeholder',
         not exists (
           select 1 from pg_authid
           where rolname = 'parley_app'
             and rolpassword = 'md5' || md5('CHANGE_ME_TO_A_LONG_RANDOM_STRING' || 'parley_app')
         ),
         'replace the placeholder password'
)
select
  ord                                as "#",
  check_name                         as "check",
  case when ok then 'PASS' else 'FAIL' end as "status",
  detail                             as "note"
from checks
order by ord;

-- =============================================================================
-- AFTER RUNNING
--
-- 1. Every row above must read PASS.
--
-- 2. Point the app at the NON-superuser role. In Supabase, take the connection
--    string from Project Settings → Database, then swap the user for parley_app:
--
--      PARLEY_DB_URL=postgresql://parley_app:<password>@db.<ref>.supabase.co:5432/postgres
--
--    Or through the pooler (note the role.ref username form):
--
--      PARLEY_DB_URL=postgresql://parley_app.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
--
--    Connecting as `postgres` will appear to work and will silently give you
--    NO row-level protection at all, because that role bypasses RLS.
--
-- 3. Confirm isolation is live. As parley_app:
--
--      set local parley.merchant_id = 'merchant-a';
--      select count(*) from audit_log;   -- only merchant-a's rows
--
--    With the setting unset, the same query must return 0 rows.
-- =============================================================================
