import type { EnrichmentStatus } from "../types";

const STYLES: Record<EnrichmentStatus, { bg: string; fg: string; label: string }> = {
  pending:  { bg: "#f1f3f5", fg: "#495057", label: "Pending" },
  running:  { bg: "#e7f5ff", fg: "#1971c2", label: "Running" },
  enriched: { bg: "#ebfbee", fg: "#2b8a3e", label: "Enriched" },
  failed:   { bg: "#fff5f5", fg: "#c92a2a", label: "Failed" },
};

export function StatusBadge({ status }: { status: EnrichmentStatus }) {
  const s = STYLES[status] ?? STYLES.pending;
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        lineHeight: 1.6,
        background: s.bg,
        color: s.fg,
        whiteSpace: "nowrap",
      }}
    >
      {s.label}
    </span>
  );
}
