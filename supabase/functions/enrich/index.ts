// =============================================================================
// Edge Function: enrich
//
// POST { "companyId": "<uuid>" }
//
// Guarantees:
//   * nothing is persisted as an enrichment unless it passed validateEnrichment();
//   * every run produces a row in enrichment_results — successes AND failures —
//     with the model, prompt version, attempt trace and repairs that produced it;
//   * a company is never left in a torn state: it ends 'enriched' or 'failed'.
// =============================================================================
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import {
  type CompanyInput,
  type EnrichmentResult,
  enrichWithLLM,
  fallbackModel,
  primaryModel,
  ProviderError,
  providerName,
  validateEnrichmentWithRepairs,
  ValidationError,
} from "./llm.ts";

/** A run that has been 'running' longer than this is treated as crashed and may be retaken. */
const STALE_RUNNING_MS = 5 * 60 * 1000;

interface AttemptLogEntry {
  attempt: number;
  model: string;
  prompt_version: string;
  outcome: "valid" | "invalid" | "provider_error";
  latency_ms?: number;
  error?: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    // --- Auth ----------------------------------------------------------------
    // The platform verifies the JWT SIGNATURE before this code runs (Supabase's
    // `verify_jwt`, on by default). What is left to do here is AUTHORISATION:
    // work out who is calling and whether they may touch this company.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Missing Authorization header" }, 401);
    }
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return json({ error: "Malformed Authorization header" }, 401);

    const caller = await identifyCaller(token);

    const { companyId } = await req.json().catch(() => ({}));
    if (!companyId) return json({ error: "companyId is required" }, 400);
    if (!isUuid(companyId)) return json({ error: "companyId must be a uuid" }, 400);

    // Service-role client: BYPASSES RLS on purpose (trusted server-side writes).
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    const { data: company, error } = await supabase
      .from("companies")
      .select("id, name, domain, raw_note, owner_id, enrichment_status")
      .eq("id", companyId)
      .single();
    if (error || !company) return json({ error: "Company not found" }, 404);

    // Because we write with the service role, RLS is bypassed — so the ownership
    // check that RLS would have done has to be repeated explicitly here. This
    // mirrors the `companies_select_own` policy exactly (NULL owner = demo row).
    if (!canAccess(caller, company.owner_id)) {
      return json({ error: "Forbidden" }, 403);
    }

    // --- Claim the run -------------------------------------------------------
    // Conditional update = a cheap optimistic lock. Two concurrent clicks on
    // "Re-run" cannot both start an enrichment; the loser gets a 409. A run that
    // died mid-flight is reclaimable once it goes stale.
    const staleBefore = new Date(Date.now() - STALE_RUNNING_MS).toISOString();
    const { data: claimed, error: claimError } = await supabase
      .from("companies")
      .update({ enrichment_status: "running" })
      .eq("id", companyId)
      .or(`enrichment_status.neq.running,updated_at.lt.${staleBefore}`)
      .select("id");

    if (claimError) throw claimError;
    if (!claimed || claimed.length === 0) {
      return json({ error: "Enrichment already running for this company" }, 409);
    }

    // --- Enrich (retry -> repair -> fallback model) ---------------------------
    const input: CompanyInput = {
      id: company.id,
      name: company.name,
      domain: company.domain,
      raw_note: company.raw_note,
    };

    const run = await runEnrichment(input);

    // --- Persist -------------------------------------------------------------
    // Both branches write an enrichment_results row. A failure is a fact worth
    // keeping, not just a 500 in a log the reviewer will never see.
    if (run.ok) {
      const { data: persisted, error: insertError } = await supabase
        .from("enrichment_results")
        .insert({
          company_id: companyId,
          status: "enriched",
          ...run.result,
          source: run.meta.source,
          provider: run.meta.provider,
          model: run.meta.model,
          prompt_version: run.meta.promptVersion,
          field_sources: buildFieldSources(run.result, run.meta.source, run.meta.model),
          attempts: run.attempts,
          latency_ms: run.totalLatencyMs,
          raw_response: run.rawResponse ?? null,
          repairs: run.repairs,
          attempt_log: run.attemptLog,
        })
        .select("*")
        .single();
      if (insertError) throw insertError;

      const { error: updateError } = await supabase
        .from("companies")
        .update({
          enrichment_status: "enriched",
          current_enrichment_id: persisted.id,
          last_enriched_at: new Date().toISOString(),
          enrichment_attempts: run.attempts,
        })
        .eq("id", companyId);
      if (updateError) throw updateError;

      return json({ ok: true, companyId, status: "enriched", enrichment: persisted });
    }

    const { data: failedRow, error: failInsertError } = await supabase
      .from("enrichment_results")
      .insert({
        company_id: companyId,
        status: "failed",
        source: run.meta.source,
        provider: run.meta.provider,
        model: run.meta.model,
        prompt_version: run.meta.promptVersion,
        attempts: run.attempts,
        latency_ms: run.totalLatencyMs,
        error: run.error,
        raw_response: run.rawResponse ?? null,
        repairs: run.repairs,
        attempt_log: run.attemptLog,
      })
      .select("*")
      .single();
    if (failInsertError) throw failInsertError;

    // Note: current_enrichment_id is deliberately NOT repointed at the failed
    // row. The dashboard keeps showing the last GOOD enrichment while the status
    // badge shows the failure — a failed re-run should not erase working data.
    const { error: failUpdateError } = await supabase
      .from("companies")
      .update({ enrichment_status: "failed", enrichment_attempts: run.attempts })
      .eq("id", companyId);
    if (failUpdateError) throw failUpdateError;

    return json(
      { ok: false, companyId, status: "failed", error: run.error, enrichment: failedRow },
      502,
    );
  } catch (e) {
    console.error("enrich: unhandled error", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

// -----------------------------------------------------------------------------
// Enrichment orchestration
// -----------------------------------------------------------------------------

type RunOutcome =
  | {
      ok: true;
      result: EnrichmentResult;
      meta: { source: string; provider: string; model: string; promptVersion: string };
      attempts: number;
      totalLatencyMs: number;
      repairs: string[];
      rawResponse: unknown;
      attemptLog: AttemptLogEntry[];
    }
  | {
      ok: false;
      error: string;
      meta: { source: string; provider: string; model: string; promptVersion: string };
      attempts: number;
      totalLatencyMs: number;
      repairs: string[];
      rawResponse: unknown;
      attemptLog: AttemptLogEntry[];
    };

/**
 * The reliability ladder:
 *   1. primary model, base prompt
 *   2. primary model, TIGHTENED prompt that quotes the exact validation error
 *   3. FALLBACK model (a stronger one), tightened prompt
 *
 * Escalating rather than just repeating: a model that produced invalid output at
 * temperature 0 will reproduce it verbatim, so attempt 2 changes the prompt and
 * attempt 3 changes the model.
 */
async function runEnrichment(company: CompanyInput): Promise<RunOutcome> {
  const primary = primaryModel();
  const fallback = fallbackModel();

  const plan: Array<{ model: string; useRepairHint: boolean }> = [
    { model: primary, useRepairHint: false },
    { model: primary, useRepairHint: true },
  ];
  if (fallback) plan.push({ model: fallback, useRepairHint: true });

  const attemptLog: AttemptLogEntry[] = [];
  let lastError = "enrichment did not run";
  let lastRepairHint: string | undefined;
  let lastRaw: unknown = null;
  // Seeded from config so a run that dies before the first call still records
  // which provider it was trying to use.
  let lastMeta = { ...providerName(), model: primary, promptVersion: "v1" };
  let totalLatencyMs = 0;

  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    const attempt = i + 1;

    try {
      const call = await enrichWithLLM(
        company,
        { model: step.model, repairHint: step.useRepairHint ? lastRepairHint : undefined },
        attempt,
      );
      lastRaw = call.raw;
      lastMeta = call.meta;
      totalLatencyMs += call.meta.latencyMs;

      const { result, repairs } = validateEnrichmentWithRepairs(call.raw);

      attemptLog.push({
        attempt,
        model: call.meta.model,
        prompt_version: call.meta.promptVersion,
        outcome: "valid",
        latency_ms: call.meta.latencyMs,
      });

      return {
        ok: true,
        result,
        meta: call.meta,
        attempts: attempt,
        totalLatencyMs,
        repairs,
        rawResponse: call.raw,
        attemptLog,
      };
    } catch (e) {
      if (e instanceof ValidationError) {
        // Bad CONTENT. Feed the exact error back into the next prompt.
        lastError = `validation failed: ${e.message}`;
        lastRepairHint = e.message;
        attemptLog.push({
          attempt,
          model: step.model,
          prompt_version: step.useRepairHint ? "v1-repair" : "v1",
          outcome: "invalid",
          error: e.message,
        });
        continue;
      }

      if (e instanceof ProviderError) {
        // Bad TRANSPORT. A non-retryable one (missing key, refusal, unimplemented
        // provider) will fail identically on every remaining attempt — stop now
        // rather than burn the ladder and the user's latency budget.
        lastError = `provider error: ${e.message}`;
        attemptLog.push({
          attempt,
          model: step.model,
          prompt_version: step.useRepairHint ? "v1-repair" : "v1",
          outcome: "provider_error",
          error: e.message,
        });
        if (!e.retryable) break;
        await sleep(250 * 2 ** i); // brief backoff before the next rung
        continue;
      }

      lastError = e instanceof Error ? e.message : String(e);
      attemptLog.push({
        attempt,
        model: step.model,
        prompt_version: "v1",
        outcome: "provider_error",
        error: lastError,
      });
    }
  }

  return {
    ok: false,
    error: lastError,
    meta: lastMeta,
    attempts: attemptLog.length,
    totalLatencyMs,
    repairs: [],
    rawResponse: lastRaw,
    attemptLog,
  };
}

/**
 * Per-field provenance. Today every field comes from the same call, so this is
 * uniform — but the column exists so that a future step (a domain-WHOIS lookup
 * for hq_country, say) can overwrite one field without losing the record of
 * where the others came from.
 */
function buildFieldSources(
  result: EnrichmentResult,
  source: string,
  model: string,
): Record<string, { source: string; model: string }> {
  const out: Record<string, { source: string; model: string }> = {};
  for (const key of Object.keys(result)) out[key] = { source, model };
  return out;
}

// -----------------------------------------------------------------------------
// Auth helpers
// -----------------------------------------------------------------------------

type Caller =
  | { kind: "service" }
  | { kind: "user"; userId: string }
  | { kind: "anon" };

/**
 * Three kinds of caller:
 *   service — the service-role key (batch jobs, n8n). Full access.
 *   user    — a signed-in end user. Verified with auth.getUser(), which checks
 *             the token against the auth server rather than trusting its claims.
 *   anon    — the public anon key with no session. Allowed, but restricted below
 *             to unowned demo rows, exactly matching the RLS SELECT policy.
 */
async function identifyCaller(token: string): Promise<Caller> {
  if (token === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) return { kind: "service" };

  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (anonKey && token === anonKey) return { kind: "anon" };

  const client: SupabaseClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    anonKey ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) return { kind: "anon" };
  return { kind: "user", userId: data.user.id };
}

function canAccess(caller: Caller, ownerId: string | null): boolean {
  if (caller.kind === "service") return true;
  if (ownerId === null) return true; // unowned demo row — see RLS notes in 0001_init.sql
  return caller.kind === "user" && caller.userId === ownerId;
}

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
