# Company Enrichment — &lt;your name&gt;

A small slice of a company-data platform: messy input rows in, validated structured
enrichment out, with the provenance and confidence behind every field visible in the
dashboard.

Stack as specified — React + TypeScript (Vite), Supabase (Postgres + Edge Functions on
Deno), OpenAI. The whole pipeline runs **without an API key** via the mock provider.

---

## How to run

### 1. Database

```bash
supabase init          # only if supabase/config.toml doesn't exist yet
supabase start         # note the printed API URL, anon key and service_role key
supabase db reset      # applies supabase/migrations/*.sql, then supabase/seed.sql
```

`supabase db reset` also loads the seed automatically — `supabase/seed.sql` is picked up
by the CLI after migrations run. It's guarded by a `NOT EXISTS` check, so re-running is a
no-op rather than a duplicate load.

*Hosted project instead of local?* Run the contents of `supabase/migrations/0001_init.sql`
and then `supabase/seed.sql` in the SQL editor, and use your project's URL/keys below.

### 2. Edge Function

```bash
cp .env.example .env
# set SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY from step 1
# leave LLM_PROVIDER=mock to run with no API key

supabase functions serve enrich --env-file ./.env
```

To use the real model instead, set `LLM_PROVIDER=openai` and `OPENAI_API_KEY=sk-...`.
Everything else — validation, retries, persistence — is identical between the two.

### 3. Web app

```bash
cd web
cp .env.example .env
# set VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY from step 1
npm install
npm run dev
```

### 4. Seeing the reliability path without an API key

The mock provider has a chaos switch so the retry ladder is demonstrable offline. In
`.env`:

| `MOCK_CHAOS` | Behaviour |
|---|---|
| `off` (default) | Valid output on attempt 1. |
| `first` | Attempt 1 returns a bad enum, a percentage confidence and an extra key; attempt 2 recovers. The row lands `enriched` with `attempts: 2` and the failure visible in `attempt_log`. |
| `always` | Every attempt fails validation. The company ends `failed`, with a `failed` row in `enrichment_results` carrying the error and the full attempt trace. |

---

## Architecture overview

```
companies_seed.json
        │  seed.sql (raw, messiness preserved)
        ▼
   companies ──────────────────────────────► React dashboard
   (raw row + denormalised status)          (paginated list, free-text filter)
        │                                              │
        │  POST /functions/v1/enrich                   │ "Run / re-run"
        │  { companyId }                               │
        ▼                                              │
   Edge Function (Deno) ◄──────────────────────────────┘
        │
        │  1. authorise caller against companies.owner_id
        │  2. claim the run (conditional UPDATE → status 'running')
        │  3. LLM call ──► normalise ──► zod validate   ┐
        │        └── invalid? tighten prompt, retry     │ up to 3 attempts
        │        └── still invalid? escalate model      ┘
        │  4. persist (service role, bypasses RLS)
        ▼
   enrichment_results (append-only, one row per RUN)
        │
        └─► companies.current_enrichment_id ──► what the dashboard displays
```

A company flows: **seeded raw** → `pending` → user clicks *Enrich* → `running` →
the function produces a validated result → a new `enrichment_results` row is inserted and
`companies.current_enrichment_id` repointed → `enriched`. If every attempt fails, a
`failed` row is still written (with the error and attempt trace) and the company is marked
`failed` — but `current_enrichment_id` is **not** repointed, so a bad re-run never erases a
good previous enrichment.

### Data model

**`companies`** — the raw layer. Seed rows load verbatim: the leading spaces in
`"  Zalando SE"`, the empty-string domains, the `"siemens"` near-duplicate of
`"Siemens AG"`. Normalising at ingest would throw away the exact problem the enrichment
step exists to solve. On top of the raw columns it carries denormalised state:
`enrichment_status`, `enrichment_attempts`, `last_enriched_at`, `current_enrichment_id`,
plus `owner_id` for tenancy.

**`enrichment_results`** — append-only, **one row per run**, successes and failures alike.
Columns: the five contract fields; run-level provenance (`source` / `provider` / `model` /
`prompt_version`); per-field provenance (`field_sources` jsonb); and a reliability trace
(`attempts`, `latency_ms`, `error`, `repairs`, `attempt_log`, `raw_response`).

---

## Key decisions & trade-offs

**Append-only results, with a pointer for reads.** An LLM pipeline is non-deterministic, so
history is the only way to answer "why did this field change?" and to compare prompt/model
versions. The usual cost of append-only is a slower read — solved with
`companies.current_enrichment_id`, which turns "the enrichment to display" into a primary-key
lookup. The alternative (`is_current` + a partial unique index) needs two writes per run and
a wider index; this needs one insert and one update.

**Status denormalised onto `companies`.** It is derivable from `enrichment_results`, so this
is deliberate duplication. The dashboard filters, sorts and paginates on status, and deriving
it would put an aggregate over the history table in the hot path of every page load. The
write that could desynchronise it is confined to a single function.

**Per-field provenance as `jsonb`, not columns.** The brief's core asks for a `source`/`model`
column so provenance is visible; the stretch is a normalised per-field audit table. `jsonb`
sits between them: the detail view renders a source and model per field today, and the field
set can change with the LLM contract without a migration. It is not efficiently queryable —
if provenance ever needs aggregating ("how many fields came from gpt-4o last week?"), that is
the signal to promote it to the real audit table.

**Synchronous enrichment.** One click, one HTTP call, one company, result rendered when it
returns. Correct for a dashboard action where the user is watching, and it keeps the failure
path observable. It is the wrong shape for the 10k-row backfill — see *what's next*.

**Failures are rows, not logs.** A failed run writes a full `enrichment_results` row with the
error, the attempt trace and the last raw model output. Debugging a bad enrichment a week
later shouldn't require re-running it.

**Validation twice, deliberately.** zod in the function is the gate; the CHECK constraints on
`enrichment_results` are the backstop. `enrichment_results_complete_when_enriched` makes a
half-filled "success" physically unrepresentable, so even a bug in the function cannot produce
one. Cheap, and it means the table's guarantees don't depend on the application being correct.

**`count: "estimated"` on the list query.** An exact `COUNT(*)` over a filtered 100k-row table
is a full scan on every keystroke. Postgres's planner estimate is effectively free, and
PostgREST falls back to an exact count when the result set is small — so a filtered search
still shows a true total, and the UI prefixes `~` when it doesn't.

**Selected columns, not `select("*")`.** The list query names its columns so
`raw_response` — the entire model payload — never crosses the wire for a row nobody has
opened. Invisible at 15 rows, decisive at 100.

---

## RLS model

**The model.** A company belongs to exactly one user via `companies.owner_id`. An
`enrichment_results` row inherits its parent company's visibility — there is no independent
ownership, because an enrichment has no meaning apart from its company.

**The policies** (`supabase/migrations/0001_init.sql`):

| Table | Command | Rule |
|---|---|---|
| `companies` | SELECT | `owner_id is null or owner_id = auth.uid()` |
| `companies` | INSERT | `WITH CHECK owner_id = auth.uid()` |
| `companies` | UPDATE | `USING` **and** `WITH CHECK` `owner_id = auth.uid()` |
| `companies` | DELETE | `owner_id = auth.uid()` |
| `enrichment_results` | SELECT | `EXISTS (company you can see)` |
| `enrichment_results` | INSERT/UPDATE | **no policy at all** |

Three things worth calling out:

1. **`USING` and `WITH CHECK` do different jobs on UPDATE.** `USING` decides which rows you
   may touch; `WITH CHECK` validates the row you're writing. With only `USING`, a user could
   update their own row and set `owner_id` to someone else's id — handing it away, or
   worse, stealing it back. Both clauses are required.

2. **`enrichment_results` has no write policy on purpose.** With RLS enabled and no
   permissive policy, writes from `anon`/`authenticated` are denied outright. Users can read
   enrichment history; only the trusted server can produce it.

3. **The Edge Function bypasses all of this.** It writes with the service role, by design —
   which means RLS provides no protection there. So the function repeats the ownership check
   in code (`canAccess()` in `index.ts`), and that check mirrors the SELECT policy
   line-for-line. This is the part that's easy to get wrong: a service-role function is only
   as safe as its own authorisation code.

**The `owner_id IS NULL` clause** makes seeded rows unowned demo data, visible to everyone.
That is a deliberate dev affordance so the dashboard shows data before auth is wired up, and
it is exactly one clause to delete for strict isolation. Wiring real auth was called out as a
stretch in the brief, and I left it out — see below.

**How I'd test it with two users.** Create users A and B via `supabase.auth.signUp`. Insert a
company owned by A and one owned by B. Then, holding A's JWT:

- `select * from companies` returns A's row and any unowned rows, never B's;
- `insert` with `owner_id = B` is rejected by the INSERT `WITH CHECK`;
- `update companies set owner_id = A where id = <B's row>` affects **0 rows** — the `USING`
  clause filters B's row out before the update is considered, so this returns success with an
  empty result rather than an error. Asserting on the *row count*, not the absence of an
  error, is the trap here;
- `update companies set owner_id = B where id = <A's row>` is rejected by the `WITH CHECK`;
- `insert into enrichment_results ...` is rejected regardless of company.

The natural home for this is a pgTAP suite in `supabase/tests/`, run by `supabase test db`.

---

## LLM reliability

Four layers, applied in order.

**1. Constrain the output at the source.** The OpenAI call uses structured outputs with
`strict: true` and the enrichment JSON Schema, so the model is decoding against a grammar
rather than being asked nicely for JSON.

One wrinkle worth knowing: OpenAI's strict mode accepts only a subset of JSON Schema, and
`maxLength` / `minimum` / `maximum` are **unsupported keywords** — sending them gets the
request rejected. So `OPENAI_WIRE_SCHEMA` drops them and zod re-imposes those bounds on the
way back. `ENRICHMENT_JSON_SCHEMA` stays as the documented contract.

**2. Normalise, narrowly.** `normaliseCandidate()` fixes documented formatting failures before
validation: a JSON object wrapped in a ```` ```json ```` fence, an answer nested under a
`result` key, `"200 employees"` where `"201-1000"` was expected, a confidence of `87` that
should have been `0.87`, a summary two characters over the limit.

The bar for anything in this layer: **it must be a deterministic formatting fix, never a guess
at missing data.** So `"51 - 200 employees"` → `"51-200"` is in (whitespace and a suffix);
`"about 500 people"` → `"201-1000"` is deliberately *out*, because inferring the size is
precisely the judgement we're validating. That value fails and triggers a retry.

Every repair that fires is recorded in `enrichment_results.repairs` and shown in the detail
view — a field that needed normalising is weaker evidence than one that came back clean, and
provenance should say so rather than hide it.

**3. Validate strictly.** `validateEnrichment()` runs a zod schema that is the single source of
truth for what may enter the database: all five fields present, `employee_size_bucket` in the
enum, `confidence` a finite number in `[0,1]`, `one_line_summary` non-empty and ≤160 chars, and
`.strict()` so an invented extra key is a failure rather than a silent drop. It throws;
there is no path that persists an enrichment without passing it.

**4. Escalate, don't repeat.** The retry ladder in `runEnrichment()`:

| Attempt | Model | Prompt |
|---|---|---|
| 1 | primary (`gpt-4o-mini`) | base, temperature 0 |
| 2 | primary | **tightened** — quotes the exact zod error and restates the violated constraints, temperature 0.2 |
| 3 | fallback (`gpt-4o`) | tightened |

The escalation is the point. Re-asking the same model the same question at temperature 0
reproduces the same invalid answer, so attempt 2 changes the *prompt* (feeding the model its
own validation error) and attempt 3 changes the *model*. Temperature moves off 0 on retry for
the same reason.

**When the model misbehaves anyway.** Content failures and transport failures are separate
types. A `ValidationError` feeds the next attempt's prompt. A `ProviderError` carries a
`retryable` flag — 429 and 5xx get a backoff and another rung, while a missing API key, a
refusal or a 4xx breaks the loop immediately rather than burning three attempts on an error
that cannot change. Every call is wrapped in a 30s `AbortController` timeout.

If the ladder is exhausted, the company is marked `failed`, a `failed` row records the error
and the per-attempt trace, and the endpoint returns 502. The frontend treats that 502 as a
*result*, not a crash — the row is re-read and the failure shown in the UI.

**Concurrency.** Claiming a run is a conditional `UPDATE ... WHERE enrichment_status <>
'running'`; if it affects zero rows, someone else is already running and the caller gets 409.
A run whose function died mid-flight is reclaimable after 5 minutes so a crash can't wedge a
row in `running` forever.

---

## What I deliberately left out / would do next

Scoped to the one-day box, core before stretch. Cut, in rough order of what I'd do next:

- **Auth, and therefore a live RLS demo.** The policies are written and the function
  authorises against `owner_id`, but nothing signs in, so the `owner_id IS NULL` clause is
  doing the work in practice. Next: a Supabase magic-link screen, drop that clause, set
  `owner_id` on insert. Half a day including the pgTAP tests described above.
- **Tests.** The highest-value gap. `normaliseCandidate()` and the retry ladder are pure
  functions over fixtures and the natural first target: malformed JSON, fenced JSON, bad
  enum, percentage confidence, over-long summary, extra key, and a ladder that succeeds on
  attempt 2 vs. exhausts. `deno test` for those, plus pgTAP for the policies. Cut for time,
  not because it's optional — this is what I'd write first if the code were going to live.
- **Batch enrichment.** Synchronous one-at-a-time is right for a dashboard click and wrong
  for a 10k backfill. That wants a queue (pgmq or a `jobs` table) with a worker respecting
  the provider's rate limit, plus request-level idempotency so a retried job doesn't produce
  a duplicate run. The n8n stretch item is the orchestration layer over exactly this.
- **Keyset pagination.** `.range()` is `LIMIT/OFFSET`, so page 2,000 still walks 50k index
  entries. The index `(owner_id, created_at desc, id desc)` was chosen so
  `WHERE (created_at, id) < (:last_created_at, :last_id)` is a drop-in — the reason `id` is
  in the ORDER BY and the index at all. Deferred because it also costs the page-number UI,
  which is more useful at 15 rows than O(1) deep paging is.
- **Mistral provider.** Only OpenAI is implemented. The shape is identical —
  `POST /v1/chat/completions` with `response_format: { type: "json_schema", ... }` — so it's
  a second `case` in `enrichWithLLM`, and having it would make the fallback rung a
  cross-*provider* one, which is a genuinely stronger failure story than a bigger model from
  the same vendor.
- **The structured filter** (stretch). `listCompanies()` already accepts a `status` param and
  the index `(owner_id, enrichment_status)` is in place; what's missing is the dropdown and
  the state plumbing — deliberately left as the small, visible next step.
- **Dedup.** The seed's `"Siemens AG"` / `"siemens"` pair is bait, and I left it alone: the
  raw layer should stay raw, and dedup is a scoring/matching problem (domain normalisation,
  name fingerprinting, a review queue for near-matches) rather than something to bolt onto
  ingest.
- **Stale-`running` sweep.** Reclaiming is currently lazy — a crashed run only unblocks when
  someone clicks again. A periodic job flipping rows stuck in `running` to `failed` would
  make the dashboard honest without a click.
- **Cost/latency numbers** (stretch). Not measured, so not claimed.
