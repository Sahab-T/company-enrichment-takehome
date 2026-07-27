import type { CSSProperties, ReactNode } from "react";
import type { Company } from "../types";
import { StatusBadge } from "./StatusBadge";

interface Props {
  rows: Company[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (company: Company) => void;

  /** Kick off (or re-run) enrichment for one row. */
  onEnrich: (company: Company) => void;
  /** Ids currently in flight, so the button can disable per row rather than globally. */
  enriching: ReadonlySet<string>;

  page: number;
  pageSize: number;
  total: number;
  estimated: boolean;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}

const PAGE_SIZES = [25, 50, 100];

const th: CSSProperties = {
  padding: "8px 8px",
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  color: "#868e96",
  fontWeight: 600,
  whiteSpace: "nowrap",
};

const td: CSSProperties = {
  padding: "10px 8px",
  verticalAlign: "top",
};

export function CompaniesTable({
  rows,
  loading,
  selectedId,
  onSelect,
  onEnrich,
  enriching,
  page,
  pageSize,
  total,
  estimated,
  onPageChange,
  onPageSizeChange,
}: Props) {
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const firstRow = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastRow = Math.min(page * pageSize, total);

  return (
    <div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 14 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #dee2e6" }}>
              <th style={th}>Name</th>
              <th style={th}>Domain</th>
              <th style={th}>Industry</th>
              <th style={th}>Status</th>
              <th style={{ ...th, textAlign: "right" }}>Conf.</th>
              <th style={th} />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const isSelected = c.id === selectedId;
              const inFlight = enriching.has(c.id) || c.enrichment_status === "running";
              // The displayed enrichment is the last GOOD one — a failed re-run
              // leaves it in place, so the table never blanks out working data.
              const e = c.enrichment;

              return (
                <tr
                  key={c.id}
                  onClick={() => onSelect(c)}
                  style={{
                    cursor: "pointer",
                    borderBottom: "1px solid #f1f3f5",
                    background: isSelected ? "#f8f9fa" : undefined,
                  }}
                >
                  <td style={{ ...td, fontWeight: 500 }}>{c.name.trim() || "—"}</td>
                  <td style={{ ...td, color: "#495057" }}>{c.domain?.trim() || "—"}</td>
                  <td style={{ ...td, color: "#495057" }}>{e?.industry ?? "—"}</td>
                  <td style={td}>
                    <StatusBadge status={inFlight ? "running" : c.enrichment_status} />
                  </td>
                  <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", color: "#495057" }}>
                    {e?.confidence != null ? Number(e.confidence).toFixed(2) : "—"}
                  </td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <button
                      onClick={(ev) => {
                        ev.stopPropagation(); // the row itself is a select target
                        onEnrich(c);
                      }}
                      disabled={inFlight}
                      style={{
                        padding: "4px 10px",
                        fontSize: 12,
                        borderRadius: 6,
                        border: "1px solid #ced4da",
                        background: inFlight ? "#f1f3f5" : "#fff",
                        color: inFlight ? "#adb5bd" : "#212529",
                        cursor: inFlight ? "default" : "pointer",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {inFlight ? "Running…" : c.enrichment_status === "pending" ? "Enrich" : "Re-run"}
                    </button>
                  </td>
                </tr>
              );
            })}

            {/* Keep the table mounted while loading: swapping it for a "Loading…"
                paragraph makes every keystroke flash the layout. */}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} style={{ ...td, color: "#868e96", padding: "24px 8px" }}>
                  {loading ? "Loading…" : "No companies match this filter."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          marginTop: 12,
          fontSize: 13,
          color: "#495057",
        }}
      >
        <span>
          {total === 0
            ? "0 companies"
            : `${firstRow}–${lastRow} of ${estimated ? "~" : ""}${total.toLocaleString()}`}
          {loading && rows.length > 0 ? " · updating…" : ""}
        </span>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label style={{ color: "#868e96" }}>
            Rows{" "}
            <select
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              style={{ padding: "3px 6px", borderRadius: 6, border: "1px solid #ced4da" }}
            >
              {PAGE_SIZES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>

          <PagerButton onClick={() => onPageChange(page - 1)} disabled={page <= 1}>
            ‹ Prev
          </PagerButton>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {page} / {lastPage}
          </span>
          <PagerButton onClick={() => onPageChange(page + 1)} disabled={page >= lastPage}>
            Next ›
          </PagerButton>
        </div>
      </div>
    </div>
  );
}

function PagerButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "4px 10px",
        borderRadius: 6,
        border: "1px solid #ced4da",
        background: disabled ? "#f8f9fa" : "#fff",
        color: disabled ? "#adb5bd" : "#212529",
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {children}
    </button>
  );
}
