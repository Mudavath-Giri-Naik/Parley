-- =============================================================================
-- Discovery Service — appearance probe log
--
-- Optional. The Discovery Service runs without it: when this table is absent,
-- probes are written to Parley's existing append-only audit_log under a system
-- actor instead, and the report says which store it read. Running this migration
-- keeps discovery observations out of the buyer-facing audit trail.
--
-- Run in: Supabase Dashboard -> SQL Editor -> New query -> Run.
-- Requires the owner role (parley_app deliberately has no CREATE privilege).
-- Safe to run on a database that already has 0001_shared_schema.sql, and safe
-- to re-run.
--
-- Data stored here:
--   KEEP    the question asked, the answer returned, the citations, a timestamp
--   KEEP    which platform and which API surface was queried
--   NEVER   no API keys, no customer identifiers, no order or payment data
--
-- The answers are third-party model output. They are recorded verbatim because
-- the point of the table is evidence, and evidence that has been summarised is
-- not evidence.
-- =============================================================================

begin;

create table if not exists public.discovery_appearance_log (
  id            bigserial   primary key,
  merchant_id   text        not null,
  created_at    timestamptz not null default now(),
  platform      text        not null,
  -- The interface actually queried, which is not always the consumer product of
  -- the same name. Recorded so a row can never imply more than it observed.
  via           text        not null default '',
  testable      boolean     not null default true,
  question      text,
  answer        text,
  mentioned     boolean,
  citations     jsonb       not null default '[]'::jsonb,
  error         text,

  constraint discovery_appearance_merchant_len check (length(merchant_id) between 1 and 200),
  constraint discovery_appearance_platform_len check (length(platform) between 1 and 60),
  -- A probe that ran must say what it asked; one that did not must say why not.
  constraint discovery_appearance_shape check (
    (testable and question is not null) or (not testable and error is not null)
  )
);

create index if not exists discovery_appearance_merchant_created_idx
  on public.discovery_appearance_log (merchant_id, created_at desc);

create index if not exists discovery_appearance_platform_idx
  on public.discovery_appearance_log (merchant_id, platform, created_at desc);

-- -----------------------------------------------------------------------------
-- Grants and isolation, matching 0001 exactly.
--
-- Append-and-read only: an observation log that can be edited afterwards proves
-- nothing, so there is no UPDATE and no DELETE.
-- -----------------------------------------------------------------------------

grant select, insert on public.discovery_appearance_log to parley_app;
grant usage, select on sequence public.discovery_appearance_log_id_seq to parley_app;

alter table public.discovery_appearance_log enable row level security;
alter table public.discovery_appearance_log force row level security;

drop policy if exists discovery_appearance_merchant_isolation on public.discovery_appearance_log;
create policy discovery_appearance_merchant_isolation on public.discovery_appearance_log
  for all
  to parley_app
  using      (merchant_id = current_setting('parley.merchant_id', true))
  with check (merchant_id = current_setting('parley.merchant_id', true));

commit;

-- =============================================================================
-- VERIFICATION — every row must read PASS
-- =============================================================================

with checks as (

  select 1 as ord, 'discovery_appearance_log exists' as check_name,
         (to_regclass('public.discovery_appearance_log') is not null) as ok,
         coalesce(to_regclass('public.discovery_appearance_log')::text, 'missing') as detail

  union all select 2, 'RLS enabled and forced',
         (select bool_and(relrowsecurity and relforcerowsecurity) from pg_class
          where relname = 'discovery_appearance_log'
            and relnamespace = 'public'::regnamespace),
         'both flags required'

  union all select 3, 'isolation policy present',
         exists (select 1 from pg_policies
                 where schemaname = 'public'
                   and tablename = 'discovery_appearance_log'
                   and policyname = 'discovery_appearance_merchant_isolation'),
         'filters every statement by merchant_id'

  union all select 4, 'append-only for the application role',
         not has_table_privilege('parley_app', 'public.discovery_appearance_log', 'DELETE')
         and not has_table_privilege('parley_app', 'public.discovery_appearance_log', 'UPDATE'),
         'no UPDATE, no DELETE'

  union all select 5, 'application role can write and read',
         has_table_privilege('parley_app', 'public.discovery_appearance_log', 'INSERT')
         and has_table_privilege('parley_app', 'public.discovery_appearance_log', 'SELECT'),
         'INSERT and SELECT required'

  union all select 6, 'no credential-shaped columns',
         not exists (select 1 from information_schema.columns
                     where table_schema = 'public'
                       and table_name = 'discovery_appearance_log'
                       and column_name ~* '(secret|password|token|api[_-]?key|authorization)'),
         'this table never stores a key'
)
select
  ord                                       as "#",
  check_name                                as "check",
  case when ok then 'PASS' else 'FAIL' end  as "status",
  detail                                    as "note"
from checks
order by ord;
