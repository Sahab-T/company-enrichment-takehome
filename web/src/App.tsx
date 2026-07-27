import { useCallback, useEffect, useRef, useState } from "react";
import { listCompanies, listEnrichmentHistory, triggerEnrich } from "./api/companies";
import type { Company, EnrichmentResult } from "./types";
import { CompaniesTable } from "./components/CompaniesTable";
import { CompanyDetail } from "./components/CompanyDetail";

const SEARCH_DEBOUNCE_MS = 300;

export default function App() {
  const [rows, setRows] = useState<Company[]>([]);
  const [total, setTotal] = useState(0);
  const [estimated, setEstimated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  // Two search states: what the user is typing, and the debounced value that
  // actually hits the server. Without this every keystroke is a round trip.
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<EnrichmentResult[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const [enriching, setEnriching] = useState<Set<string>>(new Set());
  const [runErrors, setRunErrors] = useState<Record<string, string>>({});

  // Guards against out-of-order responses: a slow request for "sie" must not
  // overwrite the results of a later request for "siemens".
  const requestSeq = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput);
      setPage(1); // a new filter invalidates the current page number
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchInput]);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const res = await listCompanies({ page, pageSize, search });
      if (seq !== requestSeq.current) return; // a newer request already won
      setRows(res.rows);
      setTotal(res.total);
      setEstimated(res.estimated);
      setLoadError(null);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setLoadError(e instanceof Error ? e.message : String(e));
      setRows([]);
      setTotal(0);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [page, pageSize, search]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = rows.find((r) => r.id === selectedId) ?? null;

  // History is only fetched for the open row, not for every row in the page.
  // Re-fetched when that row gains a new run (attempt count moves on success or
  // failure), but not merely because the page reloaded.
  const selectedAttempts = selected?.enrichment_attempts;
  useEffect(() => {
    if (!selectedId) {
      setHistory([]);
      return;
    }
    let cancelled = false;
    setHistoryLoading(true);
    listEnrichmentHistory(selectedId)
      .then((h) => !cancelled && setHistory(h))
      .catch(() => !cancelled && setHistory([]))
      .finally(() => !cancelled && setHistoryLoading(false));
    return () => {
      cancelled = true;
    };
  }, [selectedId, selectedAttempts]);

  const handleEnrich = useCallback(async (company: Company) => {
    setEnriching((prev) => new Set(prev).add(company.id));
    setRunErrors((prev) => {
      const next = { ...prev };
      delete next[company.id];
      return next;
    });

    try {
      const outcome = await triggerEnrich(company.id);

      // Patch the single row rather than refetching the page: the user may have
      // typed or paged since, and a full reload would yank the table under them.
      if (outcome.company) {
        const updated = outcome.company;
        setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      }
      if (outcome.status === "failed" && outcome.error) {
        setRunErrors((prev) => ({ ...prev, [company.id]: outcome.error! }));
      }
    } catch (e) {
      setRunErrors((prev) => ({
        ...prev,
        [company.id]: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      setEnriching((prev) => {
        const next = new Set(prev);
        next.delete(company.id);
        return next;
      });
    }
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24, maxWidth: 1200, margin: "0 auto", color: "#212529" }}>
      <h1 style={{ marginBottom: 4, fontSize: 24 }}>Company Enrichment</h1>
      <p style={{ color: "#868e96", marginTop: 0, fontSize: 14 }}>
        Raw company rows, enriched into structured fields by an LLM — with the source,
        model and confidence behind every value.
      </p>

      <div style={{ display: "flex", gap: 12, alignItems: "center", margin: "16px 0" }}>
        <input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Filter by name or domain…"
          aria-label="Filter companies by name or domain"
          style={{
            flex: 1,
            maxWidth: 360,
            padding: "8px 10px",
            fontSize: 14,
            borderRadius: 6,
            border: "1px solid #ced4da",
          }}
        />
        {searchInput && (
          <button
            onClick={() => setSearchInput("")}
            style={{
              padding: "8px 12px",
              fontSize: 13,
              borderRadius: 6,
              border: "1px solid #ced4da",
              background: "#fff",
              cursor: "pointer",
            }}
          >
            Clear
          </button>
        )}
      </div>

      {loadError && (
        <div
          style={{
            background: "#fff5f5",
            border: "1px solid #ffc9c9",
            color: "#c92a2a",
            borderRadius: 6,
            padding: "10px 12px",
            fontSize: 13,
            marginBottom: 16,
          }}
        >
          <strong>Could not load companies.</strong> {loadError}
          <div style={{ color: "#868e96", marginTop: 4 }}>
            Check <code>web/.env</code> and that the database is running and migrated.
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 24, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: "2 1 560px", minWidth: 0 }}>
          <CompaniesTable
            rows={rows}
            loading={loading}
            selectedId={selectedId}
            onSelect={(c) => setSelectedId(c.id)}
            onEnrich={handleEnrich}
            enriching={enriching}
            page={page}
            pageSize={pageSize}
            total={total}
            estimated={estimated}
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(1);
            }}
          />
        </div>
        <div style={{ flex: "1 1 280px", minWidth: 260 }}>
          <CompanyDetail
            company={selected}
            history={history}
            historyLoading={historyLoading}
            onEnrich={handleEnrich}
            enriching={selected ? enriching.has(selected.id) : false}
            error={selected ? runErrors[selected.id] ?? null : null}
          />
        </div>
      </div>
    </main>
  );
}
