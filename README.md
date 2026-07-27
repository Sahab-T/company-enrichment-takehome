# Company Enrichment — Sahab Tariq

Messy company rows in, validated structured enrichment out, with the source and confidence
behind every field visible in the dashboard.

React + TypeScript (Vite), Supabase (Postgres + Edge Functions on Deno), OpenAI. The whole
thing runs without an API key using the mock provider.

---

## How to run

### 1. Database

```bash
supabase init          # only if supabase/config.toml doesn't exist yet
supabase start         # note the printed API URL, anon key and service_role key
supabase db reset      # applies supabase/migrations/*.sql, then supabase/seed.sql
```

The CLI picks up `supabase/seed.sql` automatically after the migrations, so `db reset` loads
the 15 seed rows too. It's guarded by a `NOT EXISTS` check so re-running won't duplicate them.

If you'd rather use a hosted project, run `supabase/migrations/0001_init.sql` and then
`supabase/seed.sql` in the SQL editor and use that project's URL and keys below.

### 2. Edge Function

```bash
cp .env.example .env
# fill in SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY from step 1
# leave LLM_PROVIDER=mock if you don't want to use a key

supabase functions serve enrich --env-file ./.env
```

For the real model, set `LLM_PROVIDER=openai` and `OPENAI_API_KEY=sk-...`. Nothing else
changes: validation, retries and persistence are the same either way.

### 3. Web app

```bash
cd web
cp .env.example .env
# set VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY from step 1
npm install
npm run dev
```

### 4. Seeing the retry path without a key

The mock provider has a chaos switch so you can watch the reliability code work offline.
Set `MOCK_CHAOS` in `.env`:

- `off` (default) — valid output first time.
- `first` — attempt 1 comes back with a bad enum value, a percentage confidence and an extra
  key. Attempt 2 recovers. The row ends up `enriched` with `attempts: 2`, and the failed
  attempt is still visible in `attempt_log`.
- `always` — nothing ever validates. The company ends up `failed`, with a `failed` row in
  `enrichment_results` holding the error and the full attempt trace.

`always` is the interesting one if you want to see how failures surface in the UI.

---

## Architecture overview

```
companies_seed.json
        │  seed.sql (loaded raw, messiness intact)
        ▼
   companies ──────────────────────────────► React dashboard
   (raw row + denormalised status)          (paginated list, free-text filter)
        │                                              │
        │  POST /functions/v1/enrich                   │ "Run / re-run"
        │  { companyId }                               │
        ▼                                              │
   Edge Function (Deno) ◄──────────────────────────────┘
        │
        │  1. authorise the caller against companies.owner_id
        │  2. claim the run (conditional UPDATE → status 'running')
        │  3. LLM call ──► normalise ──► zod validate   ┐
        │        └── invalid? tighten the prompt, retry │ up to 3 attempts
        │        └── still invalid? escalate the model  ┘
        │  4. persist (service role, so RLS is bypassed)
        ▼
   enrichment_results (append-only, one row per RUN)
        │
        └─► companies.current_enrichment_id ──► what the dashboard shows
```

A company starts seeded and `pending`. You click Enrich, it goes `running`, the function
produces a validated result, a new `enrichment_results` row is inserted, and
`companies.current_enrichment_id` is repointed at it. Status becomes `enriched`.

If every attempt fails, a `failed` row still gets written with the error and the attempt
trace, and the company is marked `failed`. But `current_enrichment_id` is left alone, so a
bad re-run never wipes out a good previous enrichment.

### Data model

`companies` is the raw layer. The seed loads verbatim, including the leading spaces in
`"  Zalando SE"`, the empty-string domains, and the `"siemens"` near-duplicate of
`"Siemens AG"`. Cleaning that up at ingest would throw away the exact problem the enrichment
step exists to solve. On top of the raw columns it carries `enrichment_status`,
`enrichment_attempts`, `last_enriched_at`, `current_enrichment_id` and `owner_id`.

`enrichment_results` is append-only, one row per run, successes and failures alike. It holds
the five contract fields, run-level provenance (`source`, `provider`, `model`,
`prompt_version`), per-field provenance in a `field_sources` jsonb column, and the reliability
trace: `attempts`, `latency_ms`, `error`, `repairs`, `attempt_log`, `raw_response`.

---

## Key decisions & trade-offs

**Append-only results, with a pointer for reads.** LLM output isn't deterministic, so keeping
history is the only way to answer "why did this field change?" or to compare one prompt
version against another. Append-only usually costs you on read, which is what
`companies.current_enrichment_id` solves: finding the enrichment to display is a primary-key
lookup. I considered an `is_current` flag with a partial unique index instead, but that needs
two writes per run and a wider index. This way it's one insert and one update.

**Status is denormalised onto `companies`.** It's derivable from `enrichment_results`, so this
is duplication on purpose. The dashboard filters, sorts and paginates on status, and deriving
it would put an aggregate over the history table in the hot path of every page load. Only one
function writes it, so the risk of the two drifting apart is contained.

**Per-field provenance as jsonb rather than more columns.** The brief asks for a source/model
column in the core and a normalised per-field audit table as a stretch. jsonb sits between the
two: the detail view can show a source and model for each field today, and the field set can
change with the LLM contract without a migration. The downside is it isn't efficiently
queryable. If provenance ever needs aggregating (something like "how many fields came from
gpt-4o last week"), that's the point to promote it to a real audit table.

**Enrichment is synchronous.** One click, one HTTP call, one company, result rendered when it
comes back. That's the right shape for a dashboard action where someone is watching, and it
keeps failures visible. It's the wrong shape for a 10k backfill — see below.

**Failures are rows, not log lines.** A failed run writes a full `enrichment_results` row with
the error, the per-attempt trace and the last raw model output. Debugging a bad enrichment a
week later shouldn't mean re-running it and hoping it fails the same way.

**Validation happens twice.** zod inside the function is the gate. The CHECK constraints on
`enrichment_results` are the backstop. `enrichment_results_complete_when_enriched` makes a
half-filled success impossible to store at all, so the table's guarantees don't depend on my
application code being correct. It's cheap insurance.

**`count: "estimated"` on the list query.** An exact `COUNT(*)` over a filtered 100k-row table
is a full scan on every keystroke. The planner's estimate is basically free, and PostgREST
falls back to an exact count when the result set is small, so a filtered search still shows a
real number. The UI prefixes a `~` when it's an estimate.

**Named columns instead of `select("*")`.** The list query spells out its columns so
`raw_response`, which is the entire model payload, never crosses the wire for a row nobody has
opened. Doesn't matter at 15 rows. Matters a lot at 100.

---

## RLS model

A company belongs to one user through `companies.owner_id`. An `enrichment_results` row
inherits whatever visibility its parent company has — it has no independent owner, because an
enrichment doesn't mean anything apart from the company it describes.

The policies (all in `supabase/migrations/0001_init.sql`):

- `companies` SELECT: `owner_id is null or owner_id = auth.uid()`
- `companies` INSERT: `WITH CHECK owner_id = auth.uid()`
- `companies` UPDATE: `USING` **and** `WITH CHECK`, both `owner_id = auth.uid()`
- `companies` DELETE: `owner_id = auth.uid()`
- `enrichment_results` SELECT: `EXISTS` a company you can already see
- `enrichment_results` INSERT/UPDATE: no policy at all

Three things I'd point out:

**`USING` and `WITH CHECK` do different jobs on UPDATE.** `USING` decides which rows you're
allowed to touch. `WITH CHECK` validates the row you're writing back. With only `USING`, a
user could update their own row and set `owner_id` to someone else's id, handing the row away
or grabbing it back later. You need both.

**`enrichment_results` has no write policy deliberately.** With RLS on and no permissive
policy, writes from `anon` and `authenticated` are just denied. Users can read enrichment
history; only the trusted server produces it.

**The Edge Function bypasses all of this.** It writes with the service role, by design, which
means RLS protects nothing there. So the function repeats the ownership check in code
(`canAccess()` in `index.ts`) and that check mirrors the SELECT policy line for line. This is
the easy thing to get wrong — a service-role function is only as safe as its own authorisation
code, and it's worth being explicit that the two have to be kept in sync by hand.

The `owner_id IS NULL` clause makes seeded rows unowned demo data that everyone can see. It's
there so the dashboard shows something before auth is wired up, and it's one clause to delete
for strict isolation. The brief listed real auth as a stretch and I left it out.

### How I'd test it with two users

Create users A and B with `supabase.auth.signUp`, then insert a company owned by each. Holding
A's JWT:

- `select * from companies` returns A's row plus any unowned rows, never B's.
- Inserting with `owner_id = B` gets rejected by the INSERT `WITH CHECK`.
- `update companies set owner_id = A where id = <B's row>` affects **zero rows**. The `USING`
  clause filters B's row out before the update is even considered, so this comes back
  successful with an empty result rather than as an error. Asserting on the row count rather
  than the absence of an error is the trap here, and it's the assertion I'd get wrong first.
- `update companies set owner_id = B where id = <A's row>` gets rejected by the `WITH CHECK`.
- Inserting into `enrichment_results` gets rejected either way.

pgTAP in `supabase/tests/` run by `supabase test db` is where this belongs.

---

## LLM reliability

Four layers, in order.

**1. Constrain the output at the source.** The OpenAI call uses structured outputs with
`strict: true` and the enrichment JSON Schema, so the model is decoding against a grammar
rather than being politely asked for JSON.

One wrinkle worth knowing about: OpenAI's strict mode only accepts a subset of JSON Schema,
and `maxLength`, `minimum` and `maximum` are unsupported keywords — send them and the request
gets rejected outright. So `OPENAI_WIRE_SCHEMA` drops them and zod re-applies those bounds on
the way back. `ENRICHMENT_JSON_SCHEMA` stays as the documented contract.

**2. Normalise, but narrowly.** `normaliseCandidate()` fixes formatting failures before
validation runs: JSON wrapped in a ```` ```json ```` fence, an answer nested under a `result`
key, `"200 employees"` where a bucket was expected, a confidence of `87` that was meant to be
`0.87`, a summary a couple of characters over the limit.

The rule I held myself to here is that a repair has to be a deterministic formatting fix, never
a guess at missing data. So `"51 - 200 employees"` becomes `"51-200"`, because that's just
whitespace and a suffix. But `"about 500 people"` does **not** become `"201-1000"`, even though
it obviously means that, because inferring the size is the exact judgement being validated. It
fails and triggers a retry instead.

Every repair that fires is recorded in `enrichment_results.repairs` and shown in the detail
panel. A field that needed normalising before it validated is weaker evidence than one that
came back clean, and provenance should say so rather than quietly paper over it.

**3. Validate strictly.** `validateEnrichment()` runs a zod schema that's the single source of
truth for what's allowed into the database: all five fields present, `employee_size_bucket` in
the enum, `confidence` a finite number in `[0,1]`, `one_line_summary` non-empty and 160 chars
or fewer, and `.strict()` so an invented extra key is a failure rather than something silently
dropped. It throws, and there's no code path that persists an enrichment without going through
it.

**4. Escalate rather than repeat.** The ladder in `runEnrichment()`:

1. primary model (`gpt-4o-mini`), base prompt, temperature 0
2. primary model, tightened prompt quoting the exact zod error and restating the constraints
   it broke, temperature 0.2
3. fallback model (`gpt-4o`), tightened prompt

Escalation is the whole point. Asking the same model the same question at temperature 0 gets
you the same invalid answer, so attempt 2 changes the prompt (feeding the model its own
validation error) and attempt 3 changes the model. Temperature moves off 0 on retry for the
same reason.

**When it misbehaves anyway.** Content failures and transport failures are separate types. A
`ValidationError` feeds into the next attempt's prompt. A `ProviderError` carries a `retryable`
flag: 429s and 5xx get a backoff and another rung, while a missing API key, a refusal or a 4xx
breaks the loop straight away instead of burning three attempts on something that can't change.
Every call is wrapped in a 30 second `AbortController` timeout.

If the ladder runs out, the company is marked `failed`, a `failed` row records the error and
the per-attempt trace, and the endpoint returns 502. The frontend treats that 502 as a result
rather than a crash: it re-reads the row and shows the failure.

**Concurrency.** Claiming a run is a conditional `UPDATE ... WHERE enrichment_status <>
'running'`. If it affects zero rows, someone else is already running and the caller gets a 409.
A run whose function died partway through becomes reclaimable after 5 minutes, so a crash
can't leave a row wedged in `running` forever.

---

## What I left out, and what I'd do next

I kept to the one-day box and did the core before anything else. Roughly in the order I'd pick
them up:

**Auth, and with it a live RLS demo.** The policies are written and the function authorises
against `owner_id`, but nothing signs in, so in practice the `owner_id IS NULL` clause is doing
the work. Next step is a magic-link screen, deleting that clause, and setting `owner_id` on
insert. Maybe half a day including the pgTAP tests above.

**Tests.** This is the gap that bothers me most. `normaliseCandidate()` and the retry ladder
are pure functions over fixtures and would be straightforward to cover: malformed JSON, fenced
JSON, a bad enum, percentage confidence, an over-long summary, an extra key, plus a ladder that
succeeds on attempt 2 versus one that exhausts. `deno test` for those and pgTAP for the
policies. Cut for time rather than because I think they're optional — if this code were going
to live, this is what I'd write first.

**Batch enrichment.** Synchronous is right for a dashboard click and wrong for a 10k backfill.
That wants a queue (pgmq, or just a `jobs` table) with a worker that respects the provider's
rate limit, plus request-level idempotency so a retried job doesn't produce a duplicate run.
The n8n stretch item is the orchestration layer sitting on top of exactly that.

**Keyset pagination.** `.range()` is `LIMIT/OFFSET`, so page 2,000 still walks 50k index
entries. I picked the index `(owner_id, created_at desc, id desc)` so that
`WHERE (created_at, id) < (:last_created_at, :last_id)` drops straight in — that's the only
reason `id` is in the ORDER BY and the index at all. I didn't do it because it also costs you
the page-number UI, which is more useful at 15 rows than O(1) deep paging is.

**Mistral.** Only OpenAI is implemented. The shape is identical, a
`POST /v1/chat/completions` with `response_format: { type: "json_schema", ... }`, so it's
another `case` in `enrichWithLLM`. Worth doing mainly because it would make the fallback rung
a cross-provider one, which is a genuinely better failure story than escalating to a bigger
model from the same vendor.

**The structured filter** (stretch). `listCompanies()` already takes a `status` param and the
`(owner_id, enrichment_status)` index is there. What's missing is the dropdown and the state
plumbing. Left deliberately as the small visible next step.

**Dedup.** The `"Siemens AG"` / `"siemens"` pair in the seed is obviously bait and I left it
alone on purpose. The raw layer should stay raw, and dedup is a matching problem — domain
normalisation, name fingerprinting, a review queue for near-matches — rather than something to
bolt onto ingest.

**A sweep for stale `running` rows.** Reclaiming is lazy right now: a crashed run only unblocks
when someone clicks again. A periodic job flipping stuck rows to `failed` would make the
dashboard honest without needing a click.

**Cost and latency numbers** (stretch). I didn't measure them, so I'm not going to claim them.
