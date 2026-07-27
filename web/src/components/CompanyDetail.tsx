import type { CSSProperties } from "react";
import { ENRICHMENT_FIELDS, type Company, type EnrichmentResult } from "../types";
import { StatusBadge } from "./StatusBadge";

interface Props {
  company: Company | null;
  history: EnrichmentResult[];
  historyLoading: boolean;
  onEnrich: (company: Company) => void;
  enriching: boolean;
  /** Message from the most recent failed run of the selected company. */
  error: string | null;
}

const label: CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  color: "#868e96",
  fontWeight: 600,
};

const meta: CSSProperties = {
  fontSize: 11,
  color: "#adb5bd",
  marginTop: 2,
};

export function CompanyDetail({
  company,
  history,
  historyLoading,
  onEnrich,
  enriching,
  error,
}: Props) {
  if (!company) {
    return (
      <aside style={{ color: "#868e96", fontSize: 14 }}>
        <p>Select a company to see its enrichment.</p>
      </aside>
    );
  }

  const e = company.enrichment;
  const inFlight = enriching || company.enrichment_status === "running";

  return (
    <aside style={{ borderLeft: "1px solid #e9ecef", paddingLeft: 16, fontSize: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>{company.name.trim() || "Untitled"}</h2>
        <StatusBadge status={inFlight ? "running" : company.enrichment_status} />
      </div>

      {company.domain?.trim() && (
        <a
          href={`https://${company.domain.trim()}`}
          target="_blank"
          rel="noreferrer"
          style={{ fontSize: 13, color: "#1971c2" }}
        >
          {company.domain.trim()}
        </a>
      )}

      <p style={{ color: "#868e96", fontSize: 13, marginTop: 8 }}>
        {company.raw_note ?? "No note"}
      </p>

      <button
        onClick={() => onEnrich(company)}
        disabled={inFlight}
        style={{
          padding: "6px 12px",
          fontSize: 13,
          borderRadius: 6,
          border: "1px solid #ced4da",
          background: inFlight ? "#f1f3f5" : "#fff",
          color: inFlight ? "#adb5bd" : "#212529",
          cursor: inFlight ? "default" : "pointer",
          marginBottom: 16,
        }}
      >
        {inFlight ? "Enriching…" : company.enrichment_status === "pending" ? "Run enrichment" : "Re-run enrichment"}
      </button>

      {error && (
        <div
          style={{
            background: "#fff5f5",
            border: "1px solid #ffc9c9",
            color: "#c92a2a",
            borderRadius: 6,
            padding: "8px 10px",
            fontSize: 12,
            marginBottom: 16,
            wordBreak: "break-word",
          }}
        >
          <strong>Last run failed.</strong> {error}
        </div>
      )}

      {!e && (
        <p style={{ color: "#868e96", fontSize: 13 }}>
          Not enriched yet{company.enrichment_status === "failed" ? " — every attempt failed." : "."}
        </p>
      )}

      {e && (
        <>
          <ConfidenceBar value={e.confidence} />

          <dl style={{ margin: "16px 0 0" }}>
            {ENRICHMENT_FIELDS.map(({ key, label: fieldLabel }) => {
              const value = e[key];
              // Per-field provenance, falling back to the run-level source/model.
              const src = e.field_sources?.[key] ?? { source: e.source, model: e.model };
              return (
                <div key={key} style={{ marginBottom: 12 }}>
                  <dt style={label}>{fieldLabel}</dt>
                  <dd style={{ margin: "2px 0 0" }}>{value ?? "—"}</dd>
                  <div style={meta}>
                    {src.source} · {src.model}
                  </div>
                </div>
              );
            })}
          </dl>

          <div style={{ ...meta, borderTop: "1px solid #f1f3f5", paddingTop: 10, marginTop: 4 }}>
            <div>
              Prompt {e.prompt_version} · {e.attempts} attempt{e.attempts === 1 ? "" : "s"}
              {e.latency_ms != null ? ` · ${e.latency_ms} ms` : ""}
            </div>
            <div>Run at {new Date(e.created_at).toLocaleString()}</div>
            {e.repairs?.length > 0 && (
              // Surfaced, not hidden: a field that needed normalising before it
              // validated is weaker evidence than one that came back clean.
              <div style={{ color: "#e8590c", marginTop: 4 }}>
                Normalised: {e.repairs.join("; ")}
              </div>
            )}
          </div>
        </>
      )}

      <History rows={history} loading={historyLoading} currentId={company.current_enrichment_id} />
    </aside>
  );
}

function ConfidenceBar({ value }: { value: number | null }) {
  if (value == null) return null;
  const pct = Math.round(Math.min(1, Math.max(0, Number(value))) * 100);
  const colour = pct >= 70 ? "#2b8a3e" : pct >= 40 ? "#e8590c" : "#c92a2a";

  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", ...label }}>
        <span>Confidence</span>
        <span style={{ color: colour }}>{pct}%</span>
      </div>
      <div style={{ background: "#f1f3f5", borderRadius: 999, height: 6, marginTop: 4 }}>
        <div style={{ width: `${pct}%`, background: colour, height: 6, borderRadius: 999 }} />
      </div>
    </div>
  );
}

/** enrichment_results is append-only, so every past run is still here to show. */
function History({
  rows,
  loading,
  currentId,
}: {
  rows: EnrichmentResult[];
  loading: boolean;
  currentId: string | null;
}) {
  if (loading) return <div style={{ ...meta, marginTop: 16 }}>Loading history…</div>;
  if (rows.length <= 1) return null;

  return (
    <details style={{ marginTop: 16 }}>
      <summary style={{ ...label, cursor: "pointer" }}>Run history ({rows.length})</summary>
      <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0" }}>
        {rows.map((r) => (
          <li key={r.id} style={{ ...meta, marginBottom: 6, lineHeight: 1.5 }}>
            <span style={{ color: r.status === "enriched" ? "#2b8a3e" : "#c92a2a" }}>
              {r.status}
            </span>{" "}
            · {r.model} · {new Date(r.created_at).toLocaleString()}
            {r.id === currentId ? " · shown above" : ""}
            {r.error && <div style={{ color: "#c92a2a", wordBreak: "break-word" }}>{r.error}</div>}
          </li>
        ))}
      </ul>
    </details>
  );
}
