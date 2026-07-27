# Take-Home Task — Company Enrichment Service (starter repo)

**Role:** Full-Stack Engineer (Automation & AI Platform) · LEADING EMPLOYERS
**Time box:** ~1 focused day · **Deliverable:** a link to a git repo

---

## Context

At LEADING EMPLOYERS we take large amounts of messy, multi-source company data, enrich and
structure it with automation and LLMs, score it, and surface it in data-heavy dashboards. This
exercise is a small, self-contained slice of that.

**This repo is a partly-built starter.** The boring scaffolding is already done so you can spend your
day on the parts that actually matter. Your job is to complete the pieces marked `TODO(candidate)`.

> The **core is meant to fit a focused day**; the stretch items are genuinely optional. We care far
> more about how you think, prioritise, and communicate trade-offs than about ticking every box — a
> smaller amount of solid, well-documented work beats a sprawling half-working one.

---

## What's already in the starter

```
company-enrichment-takehome/
├── TASK.md                     <- you are here
├── README.md                   <- TEMPLATE for you to fill in (we read it carefully)
├── .env.example                <- env for Supabase + the Edge Function
├── companies_seed.json         <- ~15 deliberately messy company rows
├── supabase/
│   ├── migrations/
│   │   └── 0001_init.sql        <- `companies` table is DONE; the rest is your TODO
│   └── functions/enrich/
│       ├── index.ts             <- Edge Function skeleton: request/CORS/auth seam wired
│       └── llm.ts               <- enrichment contract + a MOCK provider so you can run
│                                   with no API key; real OpenAI/Mistral + validation = TODO
└── web/                         <- Vite + React + TypeScript app that runs out of the box
    └── src/
        ├── App.tsx              <- shell that loads + lists companies
        ├── api/companies.ts     <- data layer: naive list given, server-side paging = TODO
        └── components/          <- CompaniesTable / CompanyDetail stubs to build out
```

So you get: a running React/TS shell, the Supabase client, the Edge Function plumbing, a mock LLM
provider (run the whole thing **without** an API key), the enrichment contract (types + JSON schema),
the `companies` table, and the seed data.

## What you need to build (the assessed parts)

Search the codebase for **`TODO(candidate)`**. In short:

- [ ] **Database** (`supabase/migrations/`): design the enrichment table — an enrichment **status** plus a
      `source` / `model` column so each field's provenance is visible — the indexes your dashboard needs,
      and **one RLS policy**. In the README, explain how the policy isolates rows and how you'd test it.
      (Wiring real auth to exercise it end-to-end is a stretch, not required.)
- [ ] **Edge Function** (`supabase/functions/enrich/`): produce a **structured** enrichment, **validate**
      it strictly, **retry / fall back** on bad output (never persist unvalidated data), and **persist**
      the result + status + source. Implementing the real OpenAI/Mistral call is welcome; keeping the
      mock provider is fine if you focus on reliability + persistence.
- [ ] **Frontend** (`web/src/`): server-side **pagination** + a **free-text filter**, an enrichment
      **status** column, a **run / re-run** action, and a **detail view** showing each enriched field with
      its source + confidence. Keep it responsive assuming ~100k rows.
- [ ] **Load the seed** (`companies_seed.json`) into the DB — however you like (SQL, a quick script, or a UI action).
- [ ] **Fill in `README.md`** — setup, architecture, decisions/trade-offs, what you cut and what's next.

### Stretch (optional — only if the core is solid)
- [ ] A second, **structured filter** (e.g. by industry or status) on the dashboard.
- [ ] A separate **provenance / audit table** (a row per produced field) instead of inline `source` columns.
- [ ] An **n8n** workflow (export the JSON) that orchestrates batch enrichment with retries + error handling.
- [ ] A **materialized view** powering a dashboard stat (+ note how/when you'd refresh it).
- [ ] A few **tests** around the validation / retry logic.
- [ ] **Cost / latency** notes: what enriching 10k companies costs and how you'd reduce it.
- [ ] Basic **auth** that actually exercises your RLS policy end-to-end.

---

## Prerequisites
- Node 18+ and npm
- [Supabase CLI](https://supabase.com/docs/guides/cli) + Docker (for local Postgres + Edge Functions)
- *(optional)* an OpenAI or Mistral API key — **not required**, the mock provider runs without one

## Setup

```bash
# 1) Start local Supabase (Postgres, Auth, Edge runtime). Note the printed API URL + anon key.
supabase start

# 2) Apply migrations (this runs supabase/migrations/*.sql).
supabase db reset

# 3) Load the seed data (your choice — see the TODO above).

# 4) Serve the Edge Function with the mock LLM provider (no API key needed).
cp .env.example .env          # then set LLM_PROVIDER=mock and the SUPABASE_* values
supabase functions serve enrich --env-file ./.env

# 5) Run the web app.
cd web
cp .env.example .env          # set VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY from step 1
npm install
npm run dev
```

You can adapt any of this — if you'd rather use a hosted Supabase project or a different local setup,
that's fine; just document what you did in the README.

---

## Ground rules
- Time-box to ~1 day. It's fine to stub or fake parts — just say so in the README.
- Stick to the stack: React + TypeScript, Supabase (Postgres + Edge Functions / Deno), OpenAI or Mistral.
- **Commit incrementally** — we read your git history to understand how you work, so please don't
  squash it into a single commit.
- Never commit secrets. `.env` is gitignored; keep keys out of the repo.

## Submission
Push to a git repo (GitHub / GitLab) and send us the link. We'll then schedule a session where you
**walk us through your work, answer questions on it, and build a small extension live** (~1 hour).

Good luck — we're looking forward to seeing how you work.
