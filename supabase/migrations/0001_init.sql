-- =============================================================================
-- 0001_init.sql
-- Schema for the company enrichment service.
--
-- Design summary (the long version lives in README.md):
--   * `companies`          — raw input rows + a denormalised status so the
--                            dashboard can filter/sort/paginate without a join.
--   * `enrichment_results` — APPEND-ONLY history, one row per enrichment RUN
--                            (successful or failed). `companies.current_enrichment_id`
--                            points at the row the dashboard should display.
--   * Provenance lives at two levels: run-level (`provider` / `model` / `source`)
--     and per-field (`field_sources` jsonb), so the detail view can show where
--     each individual field came from.
-- =============================================================================

create extension if not exists pgcrypto;
-- Trigram index support for the dashboard's free-text filter (ILIKE '%foo%').
create extension if not exists pg_trgm;


-- --- Enums -------------------------------------------------------------------
-- Enums rather than text + CHECK: the bucket set is part of the LLM contract in
-- functions/enrich/llm.ts, and a mismatch should fail loudly at write time.

do $$ begin
  create type public.enrichment_status as enum ('pending', 'running', 'enriched', 'failed');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.employee_size_bucket as enum ('1-50', '51-200', '201-1000', '1001-5000', '5000+');
exception when duplicate_object then null;
end $$;


-- --- Companies ---------------------------------------------------------------
-- Raw, messy input rows (mirrors companies_seed.json).
create table if not exists public.companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  domain      text,
  raw_note    text,
  created_at  timestamptz not null default now(),

  -- Tenancy. NULL = an unowned "demo" row, visible to everyone. That is a
  -- deliberate dev affordance so the app is usable before auth is wired up;
  -- see the RLS section below and the README for how to remove it.
  owner_id    uuid references auth.users (id) on delete cascade,

  -- Denormalised enrichment state. Kept on `companies` (not derived from
  -- enrichment_results) so the list query stays a single-table scan over an
  -- index — this is what keeps the dashboard responsive at ~100k rows.
  enrichment_status     public.enrichment_status not null default 'pending',
  enrichment_attempts   integer not null default 0,
  last_enriched_at      timestamptz,
  current_enrichment_id uuid,  -- FK added below, once enrichment_results exists

  updated_at  timestamptz not null default now()
);


-- --- Enrichment results ------------------------------------------------------
-- One row per RUN, never updated in place. Rationale:
--   * an LLM pipeline is non-deterministic, so you want the history to explain
--     why a field changed (and to diff prompt/model versions);
--   * failures are first-class rows, not a lost error string;
--   * `companies.current_enrichment_id` gives the dashboard an O(1) lookup of
--     the row to display, so append-only costs nothing on read.
create table if not exists public.enrichment_results (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id) on delete cascade,

  -- 'enriched' for a validated run, 'failed' for one that never passed validation.
  status      public.enrichment_status not null,

  -- The structured contract (see ENRICHMENT_JSON_SCHEMA in functions/enrich/llm.ts).
  -- Nullable because a failed run still gets a row; the CHECK below enforces that
  -- a SUCCESSFUL run is complete.
  industry              text,
  employee_size_bucket  public.employee_size_bucket,
  hq_country            text,
  one_line_summary      text,
  confidence            numeric(4, 3),

  -- Run-level provenance.
  source          text not null,                    -- 'llm' | 'mock'
  provider        text not null,                    -- 'openai' | 'mock'
  model           text not null,                    -- e.g. 'gpt-4o-mini', 'mock-v1'
  prompt_version  text not null default 'v1',

  -- Per-field provenance, e.g.
  --   {"industry": {"source": "llm", "model": "gpt-4o-mini"}, ...}
  -- jsonb rather than 5 more columns: the field set is defined by the LLM
  -- contract and will change faster than the table should. The stretch goal (a
  -- normalised per-field audit table) is the next step if this needs querying.
  field_sources   jsonb not null default '{}'::jsonb,

  -- Reliability telemetry. This is what makes a failure debuggable a week later
  -- without re-running the pipeline.
  attempts      integer not null default 1,   -- how many LLM calls this run took
  latency_ms    integer,
  error         text,                         -- populated when status = 'failed'
  raw_response  jsonb,                        -- last raw model output, for debugging

  -- Which normalisations fired before validation, e.g. {"confidence rescaled from percentage"}.
  -- Persisted rather than logged: a field that needed repairing is a weaker
  -- signal than one that came back clean, and provenance should say so.
  repairs       text[] not null default '{}'::text[],

  -- Per-attempt trace: [{"attempt":1,"model":"gpt-4o-mini","outcome":"invalid","error":"..."}]
  attempt_log   jsonb not null default '[]'::jsonb,

  created_at    timestamptz not null default now(),

  -- Second line of defence behind validateEnrichment(): even a bug in the Edge
  -- Function cannot persist a half-filled "success".
  constraint enrichment_results_confidence_range
    check (confidence is null or (confidence >= 0 and confidence <= 1)),

  constraint enrichment_results_complete_when_enriched
    check (
      status <> 'enriched' or (
        industry             is not null and
        employee_size_bucket is not null and
        hq_country           is not null and
        one_line_summary     is not null and
        confidence           is not null
      )
    ),

  constraint enrichment_results_error_when_failed
    check (status <> 'failed' or error is not null),

  -- Only terminal states are ever persisted here.
  constraint enrichment_results_terminal_status
    check (status in ('enriched', 'failed'))
);

-- Circular-ish FK, added after both tables exist. ON DELETE SET NULL so pruning
-- old history can never orphan a company row.
alter table public.companies
  drop constraint if exists companies_current_enrichment_id_fkey;

alter table public.companies
  add constraint companies_current_enrichment_id_fkey
  foreign key (current_enrichment_id)
  references public.enrichment_results (id)
  on delete set null;


-- --- updated_at trigger ------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists companies_set_updated_at on public.companies;
create trigger companies_set_updated_at
  before update on public.companies
  for each row execute function public.set_updated_at();


-- --- Indexes -----------------------------------------------------------------
-- Driven by the three queries the dashboard actually issues. Nothing speculative.

-- 1) The list query: WHERE owner_id <...> ORDER BY created_at DESC, id DESC.
--    `id` is in the ORDER BY (and the index) to make paging deterministic when
--    created_at ties, and so keyset pagination is a drop-in later.
create index if not exists companies_owner_created_idx
  on public.companies (owner_id, created_at desc, id desc);

-- 2) The status filter / dashboard counts.
create index if not exists companies_owner_status_idx
  on public.companies (owner_id, enrichment_status);

-- 3) The free-text filter, which is `ILIKE '%term%'` on name/domain. A B-tree is
--    useless for a leading wildcard; GIN + trigram is what makes it index-backed.
create index if not exists companies_name_trgm_idx
  on public.companies using gin (name gin_trgm_ops);

create index if not exists companies_domain_trgm_idx
  on public.companies using gin (domain gin_trgm_ops);

-- 4) The detail view's "enrichment history for this company, newest first".
create index if not exists enrichment_results_company_created_idx
  on public.enrichment_results (company_id, created_at desc);

-- Deliberately NOT indexed: enrichment_results.status, industry, model. Nothing
-- filters on them yet, and every index is a write-amplification cost on a table
-- that is append-only and hot.


-- --- Row Level Security ------------------------------------------------------
-- Model: a company row belongs to exactly one user (`owner_id`), and an
-- enrichment row inherits its parent company's visibility. The Edge Function
-- writes with the SERVICE ROLE, which bypasses all of this by design — which is
-- why there is no INSERT/UPDATE policy on enrichment_results at all: end users
-- can read enrichment history but only the trusted server can produce it.
--
-- `owner_id IS NULL` = an unowned demo row. This is the one line that makes the
-- seed data visible without wiring auth; drop it to get strict isolation.
--
-- `(select auth.uid())` rather than bare `auth.uid()` so Postgres treats it as
-- an InitPlan and evaluates it once per query instead of once per row.

alter table public.companies         enable row level security;
alter table public.enrichment_results enable row level security;

drop policy if exists companies_select_own on public.companies;
create policy companies_select_own on public.companies
  for select to anon, authenticated
  using (owner_id is null or owner_id = (select auth.uid()));

drop policy if exists companies_insert_own on public.companies;
create policy companies_insert_own on public.companies
  for insert to authenticated
  with check (owner_id = (select auth.uid()));

-- USING picks the rows you may touch; WITH CHECK stops you rewriting owner_id to
-- someone else's id on the way out. Both are required.
drop policy if exists companies_update_own on public.companies;
create policy companies_update_own on public.companies
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

drop policy if exists companies_delete_own on public.companies;
create policy companies_delete_own on public.companies
  for delete to authenticated
  using (owner_id = (select auth.uid()));

-- Read-only, and only through a company you can already see. The EXISTS is a PK
-- lookup on companies, so it stays cheap.
drop policy if exists enrichment_results_select_via_company on public.enrichment_results;
create policy enrichment_results_select_via_company on public.enrichment_results
  for select to anon, authenticated
  using (
    exists (
      select 1
      from public.companies c
      where c.id = enrichment_results.company_id
        and (c.owner_id is null or c.owner_id = (select auth.uid()))
    )
  );
