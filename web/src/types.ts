export type EnrichmentStatus = "pending" | "running" | "enriched" | "failed";

export type EmployeeSizeBucket =
  | "1-50" | "51-200" | "201-1000" | "1001-5000" | "5000+";

/** Where a single field came from. Mirrors `enrichment_results.field_sources`. */
export interface FieldSource {
  source: string; // 'llm' | 'mock'
  model: string;  // 'gpt-4o-mini' | 'mock-v1'
}

/**
 * One enrichment RUN. Mirrors public.enrichment_results, which is append-only —
 * this is the row `companies.current_enrichment_id` points at.
 * Keep in sync with the contract in supabase/functions/enrich/llm.ts.
 */
export interface EnrichmentResult {
  id: string;
  company_id: string;
  status: Extract<EnrichmentStatus, "enriched" | "failed">;

  // Null on a failed run; the DB CHECK guarantees they are all present when enriched.
  industry: string | null;
  employee_size_bucket: EmployeeSizeBucket | null;
  hq_country: string | null;
  one_line_summary: string | null;
  confidence: number | null;

  // Provenance.
  source: string;
  provider: string;
  model: string;
  prompt_version: string;
  field_sources: Record<string, FieldSource>;

  // Reliability trace.
  attempts: number;
  latency_ms: number | null;
  error: string | null;
  repairs: string[];

  created_at: string;
}

/** The raw company row plus its denormalised enrichment state. */
export interface Company {
  id: string;
  name: string;
  domain: string | null;
  raw_note: string | null;
  created_at: string;

  owner_id: string | null;
  enrichment_status: EnrichmentStatus;
  enrichment_attempts: number;
  last_enriched_at: string | null;
  current_enrichment_id: string | null;

  /** Embedded via the companies_current_enrichment_id_fkey relationship. */
  enrichment: EnrichmentResult | null;
}

/** The five contract fields, in the order the detail view renders them. */
export const ENRICHMENT_FIELDS = [
  { key: "industry", label: "Industry" },
  { key: "employee_size_bucket", label: "Employee size" },
  { key: "hq_country", label: "HQ country" },
  { key: "one_line_summary", label: "Summary" },
] as const;
