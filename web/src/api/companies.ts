import { supabase } from "../lib/supabase";
import type { Company, EnrichmentResult, EnrichmentStatus } from "../types";

export interface ListParams {
  page: number; // 1-based
  pageSize: number;
  search?: string;
  /**
   * Structured filter. Wired through the query but not surfaced in the UI —
   * see the README: it was scoped out as a stretch goal, and the API layer is
   * where the cost of adding it lives.
   */
  status?: EnrichmentStatus | "all";
}

export interface ListResult {
  rows: Company[];
  total: number;
  /** True when `total` is a planner estimate rather than an exact count (see below). */
  estimated: boolean;
}

/**
 * The columns the list needs, and ONLY those. `select("*")` on the embedded
 * enrichment would drag `raw_response` (the full model payload) across the wire
 * for every row — fine for 15 rows, ruinous for a 100-row page.
 *
 * The `!companies_current_enrichment_id_fkey` hint is required: there are two FK
 * paths between these tables (enrichment_results.company_id -> companies, and
 * companies.current_enrichment_id -> enrichment_results), so PostgREST cannot
 * pick one on its own. This hint follows the second — "the enrichment currently
 * displayed for this company".
 */
const LIST_SELECT = `
  id, name, domain, raw_note, created_at, owner_id,
  enrichment_status, enrichment_attempts, last_enriched_at, current_enrichment_id,
  enrichment:enrichment_results!companies_current_enrichment_id_fkey (
    id, company_id, status, industry, employee_size_bucket, hq_country,
    one_line_summary, confidence, source, provider, model, prompt_version,
    field_sources, attempts, latency_ms, error, repairs, created_at
  )
`;

/** PostgREST escaping for the `or(...)` filter: commas and parens end the term. */
function escapeForOr(term: string): string {
  return term.replace(/([,().\\])/g, "\\$1");
}

/**
 * Server-side pagination + filtering.
 *
 * Two things keep this responsive at ~100k rows:
 *   1. `.range()` — Postgres does the LIMIT/OFFSET, we transfer one page.
 *   2. `count: "estimated"` — an exact COUNT(*) over a filtered 100k-row table
 *      is a full scan on EVERY keystroke. "estimated" reads the planner's
 *      row estimate for large results and only falls back to an exact count when
 *      the result set is small, so a filtered search still shows a true total.
 *
 * The remaining scaling limit is OFFSET itself: page 2000 still makes Postgres
 * walk 50k index entries. The index `(owner_id, created_at desc, id desc)` is
 * built so keyset pagination is a drop-in replacement — see the README.
 */
export async function listCompanies(params: ListParams): Promise<ListResult> {
  const { page, pageSize, search, status } = params;
  const from = (Math.max(1, page) - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = supabase
    .from("companies")
    .select(LIST_SELECT, { count: "estimated" });

  const term = search?.trim();
  if (term) {
    // ILIKE '%term%' on both columns, served by the pg_trgm GIN indexes.
    const safe = escapeForOr(term);
    query = query.or(`name.ilike.%${safe}%,domain.ilike.%${safe}%`);
  }

  if (status && status !== "all") {
    query = query.eq("enrichment_status", status);
  }

  // `id` as the tiebreaker makes paging deterministic when created_at ties —
  // without it, rows can silently repeat or vanish across page boundaries.
  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, to);

  if (error) throw error;

  const rows = (data ?? []) as unknown as Company[];
  const total = count ?? rows.length;

  return {
    rows,
    total,
    // Heuristic: the planner estimate is only used above ~1000 rows.
    estimated: total > 1000,
  };
}

/** The enrichment history for one company — every run, newest first. */
export async function listEnrichmentHistory(companyId: string): Promise<EnrichmentResult[]> {
  const { data, error } = await supabase
    .from("enrichment_results")
    .select(
      `id, company_id, status, industry, employee_size_bucket, hq_country,
       one_line_summary, confidence, source, provider, model, prompt_version,
       field_sources, attempts, latency_ms, error, repairs, created_at`,
    )
    .eq("company_id", companyId)
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) throw error;
  return (data ?? []) as unknown as EnrichmentResult[];
}

/** Re-read a single row after enrichment, so the table can update just that row. */
export async function getCompany(companyId: string): Promise<Company | null> {
  const { data, error } = await supabase
    .from("companies")
    .select(LIST_SELECT)
    .eq("id", companyId)
    .maybeSingle();

  if (error) throw error;
  return (data as unknown as Company) ?? null;
}

export interface EnrichOutcome {
  company: Company | null;
  status: "enriched" | "failed";
  error?: string;
}

/**
 * Invoke the `enrich` Edge Function, then re-read the row so the UI reflects
 * what was actually persisted rather than what we hoped happened.
 *
 * Note the deliberate asymmetry: a 502 from the function is NOT an exception
 * here. "The model failed validation three times and we recorded that" is a
 * legitimate outcome the dashboard should show, not a crash.
 */
export async function triggerEnrich(companyId: string): Promise<EnrichOutcome> {
  const { data, error } = await supabase.functions.invoke("enrich", {
    body: { companyId },
  });

  if (error) {
    // FunctionsHttpError carries the response; dig out the function's own message.
    let message = error.message;
    const context = (error as { context?: Response }).context;
    if (context && typeof context.json === "function") {
      const body = await context.json().catch(() => null);
      if (body?.error) message = body.error;

      // 502 = the pipeline ran and failed cleanly. The row was still written.
      if (context.status === 502) {
        return { company: await getCompany(companyId), status: "failed", error: message };
      }
    }
    throw new Error(message);
  }

  if (data && data.ok === false) {
    return { company: await getCompany(companyId), status: "failed", error: data.error };
  }

  return { company: await getCompany(companyId), status: "enriched" };
}
