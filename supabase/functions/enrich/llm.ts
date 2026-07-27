// =============================================================================
// LLM enrichment.
//
// Three things live here:
//   1. THE CONTRACT   — the TypeScript type, the JSON Schema handed to the model,
//                       and the zod schema that is the single source of truth for
//                       what is allowed into the database.
//   2. THE PROVIDERS  — a deterministic mock (runs with no API key) and a real
//                       OpenAI call using structured outputs.
//   3. THE GATE       — normaliseCandidate() + validateEnrichment(). Nothing
//                       reaches Postgres without passing validateEnrichment().
//
// The retry/fallback ORCHESTRATION is in index.ts; this module stays a pure
// "one attempt in, one result or one throw out" layer so it is easy to test.
// =============================================================================

import { z } from "npm:zod@3.23.8";

export type EmployeeSizeBucket =
  | "1-50" | "51-200" | "201-1000" | "1001-5000" | "5000+";

export const EMPLOYEE_SIZE_BUCKETS = [
  "1-50", "51-200", "201-1000", "1001-5000", "5000+",
] as const satisfies readonly EmployeeSizeBucket[];

// The structured shape every enrichment must conform to.
export interface EnrichmentResult {
  industry: string;
  employee_size_bucket: EmployeeSizeBucket;
  hq_country: string;
  one_line_summary: string;
  confidence: number; // 0..1
}

export interface CompanyInput {
  id: string;
  name: string;
  domain: string | null;
  raw_note: string | null;
}

// Hand this to OpenAI/Mistral structured-output / function-calling APIs.
export const ENRICHMENT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["industry", "employee_size_bucket", "hq_country", "one_line_summary", "confidence"],
  properties: {
    industry: { type: "string" },
    employee_size_bucket: { type: "string", enum: [...EMPLOYEE_SIZE_BUCKETS] },
    hq_country: { type: "string" },
    one_line_summary: { type: "string", maxLength: 160 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;

// OpenAI's *strict* structured-output mode only accepts a subset of JSON Schema:
// `maxLength`, `minimum` and `maximum` are unsupported keywords and the request
// is rejected outright if they are present. So the wire schema drops them and
// zod re-imposes those bounds on the way back. The contract above stays the
// documentation; this is the transport encoding of it.
const OPENAI_WIRE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [...ENRICHMENT_JSON_SCHEMA.required],
  properties: {
    industry: { type: "string" },
    employee_size_bucket: { type: "string", enum: [...EMPLOYEE_SIZE_BUCKETS] },
    hq_country: { type: "string" },
    one_line_summary: { type: "string" },
    confidence: { type: "number" },
  },
} as const;

export const MAX_SUMMARY_LENGTH = 160;

// The single source of truth for "is this safe to persist?".
// `.strict()` mirrors `additionalProperties: false` — a model that invents an
// extra key has not followed the contract and we want to know about it.
export const enrichmentSchema = z
  .object({
    industry: z.string().trim().min(1, "industry must not be empty").max(120),
    employee_size_bucket: z.enum(EMPLOYEE_SIZE_BUCKETS),
    hq_country: z.string().trim().min(1, "hq_country must not be empty").max(120),
    one_line_summary: z
      .string()
      .trim()
      .min(1, "one_line_summary must not be empty")
      .max(MAX_SUMMARY_LENGTH),
    confidence: z
      .number({ invalid_type_error: "confidence must be a number" })
      .finite("confidence must be finite")
      .min(0)
      .max(1),
  })
  .strict();

// -----------------------------------------------------------------------------
// Provider plumbing
// -----------------------------------------------------------------------------

export interface ProviderMeta {
  source: "llm" | "mock";
  provider: string;   // 'openai' | 'mock'
  model: string;      // 'gpt-4o-mini' | 'mock-v1' | ...
  promptVersion: string;
  latencyMs: number;
}

export interface LLMCallResult {
  /** Unvalidated model output. MUST go through validateEnrichment() before use. */
  raw: unknown;
  meta: ProviderMeta;
}

export interface EnrichOptions {
  /** Override the model for this attempt (used for the fallback model). */
  model?: string;
  /**
   * The validation error from the previous attempt. When present the prompt is
   * tightened: the model is shown exactly what it got wrong and told to fix it.
   */
  repairHint?: string;
}

/** Thrown for provider/transport failures (HTTP, timeout) as opposed to bad content. */
export class ProviderError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) {
    super(message);
    this.name = "ProviderError";
  }
}

const PROVIDER = Deno.env.get("LLM_PROVIDER") ?? "mock";
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o-mini";
const OPENAI_FALLBACK_MODEL = Deno.env.get("OPENAI_FALLBACK_MODEL") ?? "gpt-4o";
const REQUEST_TIMEOUT_MS = Number(Deno.env.get("LLM_TIMEOUT_MS") ?? 30_000);

// Deliberately corrupt the mock's output so the retry/fallback path can be
// exercised end-to-end with no API key. 'off' | 'first' | 'always'.
const MOCK_CHAOS = Deno.env.get("MOCK_CHAOS") ?? "off";

export const PROMPT_VERSION_BASE = "v1";
export const PROMPT_VERSION_REPAIR = "v1-repair";

/** The configured provider name, so a run that fails before any call still records it. */
export function providerName(): { source: "llm" | "mock"; provider: string } {
  return PROVIDER === "mock"
    ? { source: "mock", provider: "mock" }
    : { source: "llm", provider: PROVIDER };
}

/** The model this provider uses by default — needed to decide the fallback. */
export function primaryModel(): string {
  return PROVIDER === "openai" ? OPENAI_MODEL : "mock-v1";
}

/** The model to escalate to when the primary keeps producing invalid output. */
export function fallbackModel(): string | null {
  if (PROVIDER !== "openai") return null;
  return OPENAI_FALLBACK_MODEL === OPENAI_MODEL ? null : OPENAI_FALLBACK_MODEL;
}

export async function enrichWithLLM(
  company: CompanyInput,
  opts: EnrichOptions = {},
  attempt = 1,
): Promise<LLMCallResult> {
  const startedAt = performance.now();
  const promptVersion = opts.repairHint ? PROMPT_VERSION_REPAIR : PROMPT_VERSION_BASE;

  switch (PROVIDER) {
    case "openai": {
      const model = opts.model ?? OPENAI_MODEL;
      const raw = await callOpenAI(company, model, opts.repairHint);
      return {
        raw,
        meta: {
          source: "llm",
          provider: "openai",
          model,
          promptVersion,
          latencyMs: Math.round(performance.now() - startedAt),
        },
      };
    }

    case "mistral":
      // Deliberately not implemented — see README ("what I left out"). The shape
      // is identical to callOpenAI(): POST /v1/chat/completions with
      // response_format: { type: "json_schema", json_schema: { ... , strict: true } }.
      throw new ProviderError("LLM_PROVIDER=mistral is not implemented", false);

    case "mock":
    default: {
      const raw = mockEnrich(company, attempt);
      return {
        raw,
        meta: {
          source: "mock",
          provider: "mock",
          model: "mock-v1",
          promptVersion,
          latencyMs: Math.round(performance.now() - startedAt),
        },
      };
    }
  }
}

// -----------------------------------------------------------------------------
// OpenAI
// -----------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  "You enrich company records for a B2B data platform.",
  "You are given a messy, possibly incomplete company row. Infer the structured fields.",
  "",
  "Rules:",
  "- Answer ONLY from the supplied row plus well-known public knowledge about the company.",
  "- Never invent a specific fact you are unsure of. Use \"Unknown\" for industry or hq_country",
  "  rather than guessing, and lower the confidence accordingly.",
  "- hq_country is a country name in English (e.g. \"Germany\"), not a city.",
  `- one_line_summary is at most ${MAX_SUMMARY_LENGTH} characters, plain text, no trailing period needed.`,
  "- confidence is your own calibrated certainty as a decimal between 0 and 1 (e.g. 0.72).",
  "  It is NOT a percentage. A row with only a name and no note should score below 0.4.",
].join("\n");

function userPrompt(company: CompanyInput, repairHint?: string): string {
  const row = [
    `name: ${JSON.stringify(company.name)}`,
    `domain: ${JSON.stringify(company.domain ?? null)}`,
    `raw_note: ${JSON.stringify(company.raw_note ?? null)}`,
  ].join("\n");

  if (!repairHint) return `Enrich this company row:\n\n${row}`;

  // Tightened retry: show the model its own mistake rather than just asking again.
  return [
    `Enrich this company row:`,
    ``,
    row,
    ``,
    `Your previous answer was REJECTED by schema validation:`,
    `  ${repairHint}`,
    ``,
    `Return corrected JSON that satisfies every constraint. In particular:`,
    `  - employee_size_bucket must be exactly one of: ${EMPLOYEE_SIZE_BUCKETS.join(", ")}`,
    `  - confidence must be a decimal between 0 and 1, not a percentage`,
    `  - one_line_summary must be at most ${MAX_SUMMARY_LENGTH} characters`,
    `  - include no keys other than the five required ones`,
  ].join("\n");
}

async function callOpenAI(
  company: CompanyInput,
  model: string,
  repairHint?: string,
): Promise<unknown> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) {
    throw new ProviderError("OPENAI_API_KEY is not set but LLM_PROVIDER=openai", false);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        // Low but non-zero: a retry at temperature 0 would deterministically
        // reproduce the same invalid answer.
        temperature: repairHint ? 0.2 : 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt(company, repairHint) },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "company_enrichment",
            strict: true,
            schema: OPENAI_WIRE_SCHEMA,
          },
        },
      }),
    });
  } catch (e) {
    clearTimeout(timeout);
    const aborted = e instanceof DOMException && e.name === "AbortError";
    throw new ProviderError(
      aborted ? `OpenAI request timed out after ${REQUEST_TIMEOUT_MS}ms` : `OpenAI request failed: ${String(e)}`,
      true,
    );
  }
  clearTimeout(timeout);

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    // 429 and 5xx are worth another attempt; 4xx (bad key, bad schema) are not.
    const retryable = response.status === 429 || response.status >= 500;
    throw new ProviderError(
      `OpenAI returned ${response.status}: ${body.slice(0, 300)}`,
      retryable,
      response.status,
    );
  }

  const payload = await response.json();

  // Structured outputs can still refuse, and a refusal is not a parse error.
  const message = payload?.choices?.[0]?.message;
  if (message?.refusal) {
    throw new ProviderError(`OpenAI refused the request: ${message.refusal}`, false);
  }

  const content = message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new ProviderError("OpenAI returned an empty completion", true);
  }

  // Returned UNPARSED-SAFE: normaliseCandidate()/validateEnrichment() own all
  // interpretation of the payload, so there is exactly one gate to audit.
  return content;
}

// -----------------------------------------------------------------------------
// Mock provider
// -----------------------------------------------------------------------------

// Deterministic, plausible output so the pipeline runs end-to-end without a key.
function mockEnrich(company: CompanyInput, attempt: number): unknown {
  const note = (company.raw_note ?? "").toLowerCase();

  const bucket: EmployeeSizeBucket =
    note.includes("300k") || note.includes("very large") ? "5000+"
    : note.includes("5000") ? "1001-5000"
    : note.includes("few thousand") ? "201-1000"
    : "51-200";

  const industry =
    note.includes("bank") || note.includes("fintech") ? "Financial Services"
    : note.includes("fashion") || note.includes("retail") || note.includes("e-commerce") ? "Retail / E-commerce"
    : note.includes("software") || note.includes("ai") || note.includes("mining") ? "Software"
    : note.includes("logistics") ? "Logistics"
    : note.includes("biotech") || note.includes("mrna") ? "Biotech"
    : "Unknown";

  const result: EnrichmentResult = {
    industry,
    employee_size_bucket: bucket,
    hq_country: "Germany",
    one_line_summary: `${company.name.trim()} — ${company.raw_note ?? "no description provided"}`
      .slice(0, MAX_SUMMARY_LENGTH),
    // Vary confidence with how much we actually managed to infer, so the
    // dashboard's confidence column shows a realistic spread rather than 0.5s.
    confidence: Number(
      (
        0.35 +
        (industry !== "Unknown" ? 0.25 : 0) +
        (company.domain ? 0.2 : 0) +
        (note.length > 40 ? 0.1 : 0)
      ).toFixed(2),
    ),
  };

  // Chaos mode: emit output that deliberately violates the contract, so the
  // retry -> repair -> fallback path is demonstrable without an API key.
  const misbehave = MOCK_CHAOS === "always" || (MOCK_CHAOS === "first" && attempt === 1);
  if (misbehave) {
    return {
      ...result,
      employee_size_bucket: "about 500 people", // not in the enum
      confidence: 87,                            // percentage, not 0..1
      notes: "an extra key the schema does not allow",
    };
  }

  return result;
}

// -----------------------------------------------------------------------------
// The gate: normalise, then validate strictly
// -----------------------------------------------------------------------------

/**
 * Narrow, well-known repairs applied BEFORE strict validation.
 *
 * The bar for adding anything here: it must be a deterministic formatting fix
 * for a documented LLM failure mode, never a guess at missing data. Everything
 * that survives this function still has to satisfy `enrichmentSchema`, and every
 * repair that fires is recorded so it is visible rather than silent.
 */
export function normaliseCandidate(raw: unknown): { value: unknown; repairs: string[] } {
  const repairs: string[] = [];
  let value = raw;

  // 1. Models — even in JSON mode — sometimes wrap the object in a ```json fence.
  if (typeof value === "string") {
    const unfenced = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try {
      value = JSON.parse(unfenced);
      repairs.push("parsed JSON from string response");
    } catch {
      return { value: raw, repairs }; // let validation produce the real error
    }
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { value, repairs };
  }

  const obj = { ...(value as Record<string, unknown>) };

  // 2. Some models nest the answer under a wrapper key.
  if (Object.keys(obj).length === 1) {
    for (const key of ["enrichment", "result", "data", "company"]) {
      const inner = obj[key];
      if (inner && typeof inner === "object" && !Array.isArray(inner)) {
        const nested = normaliseCandidate(inner);
        return { value: nested.value, repairs: [...repairs, `unwrapped "${key}"`, ...nested.repairs] };
      }
    }
  }

  // 3. employee_size_bucket: fix formatting only (whitespace, separators, an
  //    "employees" suffix, thousands separators). A value that still is not in
  //    the enum is a real failure and must NOT be mapped to a nearby bucket —
  //    guessing the size is exactly the mistake we are guarding against.
  if (typeof obj.employee_size_bucket === "string") {
    const original = obj.employee_size_bucket;
    const cleaned = original
      .toLowerCase()
      .replace(/employees?|people|staff|headcount/g, "")
      .replace(/,/g, "")
      .replace(/[–—]/g, "-")
      .replace(/\s+/g, "")
      .trim();
    const match = EMPLOYEE_SIZE_BUCKETS.find((b) => b.replace(/\s+/g, "") === cleaned);
    if (match && match !== original) {
      obj.employee_size_bucket = match;
      repairs.push(`employee_size_bucket "${original}" -> "${match}"`);
    }
  }

  // 4. confidence: accept a numeric string, and rescale an obvious percentage.
  //    Bounded deliberately: only a value in (1, 100] is treated as a percentage,
  //    so genuinely nonsensical numbers (-3, 4000) still fail validation.
  if (typeof obj.confidence === "string" && obj.confidence.trim() !== "") {
    const parsed = Number(obj.confidence.replace("%", "").trim());
    if (Number.isFinite(parsed)) {
      obj.confidence = obj.confidence.includes("%") ? parsed / 100 : parsed;
      repairs.push("confidence parsed from string");
    }
  }
  if (typeof obj.confidence === "number" && obj.confidence > 1 && obj.confidence <= 100) {
    obj.confidence = Number((obj.confidence / 100).toFixed(3));
    repairs.push("confidence rescaled from percentage");
  }
  if (typeof obj.confidence === "number" && Number.isFinite(obj.confidence)) {
    // numeric(4,3) in Postgres — round here rather than let the insert fail.
    const rounded = Number(obj.confidence.toFixed(3));
    if (rounded !== obj.confidence) obj.confidence = rounded;
  }

  // 5. one_line_summary: truncate an overlong summary instead of burning a retry
  //    on it. The field is prose, the length cap is ours, and a truncated summary
  //    is still correct data — unlike a guessed enum value.
  if (typeof obj.one_line_summary === "string") {
    const trimmed = obj.one_line_summary.trim();
    if (trimmed.length > MAX_SUMMARY_LENGTH) {
      obj.one_line_summary = trimmed.slice(0, MAX_SUMMARY_LENGTH - 1).trimEnd() + "…";
      repairs.push("one_line_summary truncated");
    }
  }

  return { value: obj, repairs };
}

/** Thrown when model output does not satisfy the contract. Distinct from ProviderError. */
export class ValidationError extends Error {
  constructor(message: string, readonly repairs: string[] = []) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * The only way data gets into the database. Throws on anything that does not
 * conform: missing field, wrong type, unknown enum member, out-of-range
 * confidence, or an extra key.
 */
export function validateEnrichment(raw: unknown): EnrichmentResult {
  const { value, repairs } = normaliseCandidate(raw);
  const parsed = enrichmentSchema.safeParse(value);

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ValidationError(detail, repairs);
  }

  return parsed.data;
}

/** Same as validateEnrichment() but also reports which repairs fired, for provenance. */
export function validateEnrichmentWithRepairs(
  raw: unknown,
): { result: EnrichmentResult; repairs: string[] } {
  const { value, repairs } = normaliseCandidate(raw);
  const parsed = enrichmentSchema.safeParse(value);

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ValidationError(detail, repairs);
  }

  return { result: parsed.data, repairs };
}
