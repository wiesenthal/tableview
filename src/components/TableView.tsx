import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Table } from "apache-arrow";
import { ask } from "@tauri-apps/plugin-dialog";
import { ChevronLeft, ChevronRight, Filter as FilterIcon, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { api, errorText } from "../api";
import { newId, useStore } from "../store";
import type { BrowseOptions, Changes, Filter, QueryResult, TableRef, TableStructure } from "../types";
import { cellText, DataGrid, editKey } from "./DataGrid";
import { CommitDialog, InsertDialog } from "./Dialogs";
import "../grid.css";

/** Filter column meaning "any column"; matches the backend's ANY_COLUMN. */
const ANY_COLUMN = "*";

const OPS = ["=", "!=", "<", ">", "<=", ">=", "contains", "is null", "is not null"];
const PAGE_SIZES = [300, 1000, 5000, 20000];
/** Above this many (estimated) rows, COUNT(*) waits for a click: it reads the whole table. */
const AUTO_COUNT_LIMIT = 1_000_000;

/** Browse results carry the database's row estimate for the table. */
type PageResult = QueryResult & { estimated_rows?: number | null };

/** Re-indents JSON text without parsing it into numbers, so big integers and key order survive. */
function prettyJson(text: string): string | null {
  const t = text.trim();
  if (!/^[[{]/.test(t)) return null;
  try { JSON.parse(t); } catch { return null; }
  let out = "", depth = 0, inString = false;
  const nl = () => "\n" + "  ".repeat(depth);
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inString) {
      out += c;
      if (c === "\\") out += t[++i];
      else if (c === '"') inString = false;
      continue;
    }
    if (/\s/.test(c)) continue;
    if (c === '"') { inString = true; out += c; }
    else if (c === "{" || c === "[") {
      const close = c === "{" ? "}" : "]";
      let j = i + 1;
      while (/\s/.test(t[j] ?? "")) j++;
      if (t[j] === close) { out += c + close; i = j; continue; }
      depth++;
      out += c + nl();
    } else if (c === "}" || c === "]") { depth--; out += nl() + c; }
    else if (c === ",") out += "," + nl();
    else if (c === ":") out += ": ";
    else out += c;
  }
  return out;
}

let lastInspectorWidth = 320;

export function TableView({ connectionId, table: ref, filters, active }: { connectionId: string; table: TableRef; filters?: Filter[]; active: boolean }) {
  const notify = useStore((s) => s.notify);
  const readOnly = useStore((s) => s.connections.find((c) => c.id === connectionId)?.read_only ?? false);
  const [mode, setMode] = useState<"data" | "structure">("data");
  const [structure, setStructure] = useState<TableStructure | null>(null);
  const [opts, setOpts] = useState<BrowseOptions>({ limit: 1000, offset: 0, filters: filters ?? [], order_by: null });
  const [draftFilters, setDraftFilters] = useState<Filter[]>(filters ?? []);
  const [showFilters, setShowFilters] = useState(!!filters?.length);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [data, setData] = useState<Table | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [estimate, setEstimate] = useState<number | null>(null);
  const [counting, setCounting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Map<string, string | null>>(new Map());
  const [deleted, setDeleted] = useState<Set<number>>(new Set());
  const [inserts, setInserts] = useState<Record<string, string | null>[]>([]);
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const [selectedRows, setSelectedRows] = useState<number[]>([]);
  const [preview, setPreview] = useState<string[] | null>(null);
  const [inserting, setInserting] = useState(false);
  const [inspectorWidth, setInspectorWidth] = useState(lastInspectorWidth);
  const prevResult = useRef<string | null>(null);
  const loadSeq = useRef(0);
  /** Lets the backend cancel this tab's previous filtered page when a new one starts. */
  const browseKey = useRef(newId("browse"));
  const countedFilters = useRef<string | null>(null);
  const filterBar = useRef<HTMLDivElement>(null);

  const keyColumns = useMemo(
    () => new Set((structure?.columns ?? []).filter((c) => c.is_pk || c.is_fk).map((c) => c.name)),
    [structure],
  );
  const links = useMemo(
    () => new Map((structure?.columns ?? []).flatMap((c) => (c.references ? [[c.name, c.references] as const] : []))),
    [structure],
  );
  /** Opens the row a foreign key value points at, as a filtered tab on its table. */
  const followLink = useCallback((column: string, value: string) => {
    const to = links.get(column);
    if (!to) return;
    const s = useStore.getState();
    const target = s.schemas[connectionId]?.schemas.flatMap((g) => g.tables).find((t) => t.schema === to.schema && t.name === to.table);
    s.openTable(target ?? { schema: to.schema, name: to.table, kind: "table" }, connectionId, [{ column: to.column, op: "=", value }]);
  }, [links, connectionId]);
  const editable = !readOnly && ref.kind === "table" && (structure?.columns.some((c) => c.is_pk) ?? false);
  const pending = edits.size + deleted.size + inserts.length;

  const estimateRef = useRef<number | null>(null);
  estimateRef.current = estimate;

  /** Exact COUNT(*) for the current filters; `seq` drops the answer if the page changed meanwhile. */
  const countNow = useCallback((o: BrowseOptions, seq = loadSeq.current) => {
    setCounting(true);
    const filterKey = JSON.stringify(o.filters);
    api.countRows(connectionId, ref.schema, ref.name, o)
      .then((n) => { if (countedFilters.current === filterKey) setTotal(n); })
      .catch((e) => seq === loadSeq.current && notify(errorText(e), true))
      .finally(() => setCounting(false));
  }, [connectionId, ref.schema, ref.name, notify]);

  const load = useCallback(async (o: BrowseOptions, refresh = false) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    // Count once per filter set (or on refresh), not on every page.
    const filterKey = JSON.stringify(o.filters);
    const recount = filterKey !== countedFilters.current || refresh;
    if (recount) {
      countedFilters.current = filterKey;
      setTotal(null);
    }
    try {
      const r: PageResult = await api.browseTable(connectionId, ref.schema, ref.name, { ...o, supersede: browseKey.current } as BrowseOptions);
      const t = await api.resultTable(r.id);
      if (seq !== loadSeq.current) {
        api.releaseResult(r.id).catch(() => {});
        return;
      }
      if (prevResult.current) api.releaseResult(prevResult.current).catch(() => {});
      prevResult.current = r.id;
      setResult(r);
      setData(t);
      setEdits(new Map());
      setDeleted(new Set());
      setInserts([]);
      if (recount) {
        const est = r.estimated_rows ?? null;
        if (!o.filters.length) setEstimate(est);
        // On a huge table an exact count (filtered or not) is a full scan, so it waits for a click.
        const huge = (o.filters.length ? estimateRef.current : est) ?? 0;
        if (huge <= AUTO_COUNT_LIMIT) countNow(o, seq);
      }
    } catch (e) {
      if (seq === loadSeq.current) setError(errorText(e));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [connectionId, ref.schema, ref.name, countNow]);

  useEffect(() => {
    api.describeTable(connectionId, ref.schema, ref.name).then(setStructure).catch((e) => setError(errorText(e)));
    load(opts);
    return () => {
      if (prevResult.current) api.releaseResult(prevResult.current).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, ref.schema, ref.name]);

  const apply = async (patch: Partial<BrowseOptions>, refresh = false) => {
    if (pending && !(await ask("Your unsaved changes will be lost.", { title: "Discard unsaved changes?", kind: "warning", okLabel: "Discard" }))) return;
    const o = { ...opts, ...patch };
    setOpts(o);
    load(o, refresh);
  };

  // A foreign key link into this already-open tab: show the row it points at.
  const firstFilters = useRef(filters);
  useEffect(() => {
    if (!filters || filters === firstFilters.current) return;
    firstFilters.current = filters;
    setDraftFilters(filters);
    setShowFilters(true);
    apply({ filters, offset: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  const changes = useCallback((): Changes => {
    const out: Changes = { edits: [], deletes: [...deleted], inserts };
    if (data) {
      edits.forEach((value, k) => {
        const [row, col] = k.split(":").map(Number);
        out.edits.push({ row, column: data.schema.fields[col].name, value });
      });
    }
    return out;
  }, [edits, deleted, inserts, data]);

  const review = useCallback(async () => {
    if (!pending) return;
    try {
      const r = await api.commitChanges(connectionId, ref.schema, ref.name, result?.id ?? null, changes(), true);
      setPreview(r.statements);
    } catch (e) {
      notify(errorText(e), true);
    }
  }, [pending, connectionId, ref, result, changes, notify]);

  const commit = async () => {
    try {
      const r = await api.commitChanges(connectionId, ref.schema, ref.name, result?.id ?? null, changes(), false);
      setPreview(null);
      notify(`Saved. ${r.rows_affected} row${r.rows_affected === 1 ? "" : "s"} changed.`);
      load(opts, true);
    } catch (e) {
      setPreview(null);
      notify(errorText(e), true);
    }
  };

  const focusFilter = useCallback(() => {
    const el = filterBar.current?.querySelector<HTMLInputElement>("input") ?? filterBar.current?.querySelector<HTMLElement>("select");
    el?.focus();
    if (el instanceof HTMLInputElement) el.select();
  }, []);

  /** ⌘F: open on "any column contains", focus it if open, close it if already focused. */
  const toggleFilters = useCallback(() => {
    if (showFilters && !filterBar.current?.contains(document.activeElement)) {
      focusFilter();
      return;
    }
    setShowFilters((on) => !on);
    setDraftFilters((d) => (d.length ? d : [{ column: ANY_COLUMN, op: "contains", value: "" }]));
  }, [showFilters, focusFilter]);

  useEffect(() => {
    if (showFilters) focusFilter();
  }, [showFilters, focusFilter]);

  // A lone "any column contains" filter is a quick search: it applies as you type.
  const quickSearch = draftFilters.length === 1 && draftFilters[0].column === ANY_COLUMN ? draftFilters[0].value : null;
  const applied = opts.filters.length === 1 && opts.filters[0].column === ANY_COLUMN ? opts.filters[0].value : opts.filters.length ? null : "";
  useEffect(() => {
    if (quickSearch === null || quickSearch === applied || pending) return;
    const t = setTimeout(() => apply({ filters: quickSearch ? draftFilters : [], offset: 0 }), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickSearch]);

  const toggleDeleted = useCallback((rows: number[]) => {
    setDeleted((d) => {
      const n = new Set(d);
      rows.forEach((r) => (n.has(r) ? n.delete(r) : n.add(r)));
      return n;
    });
  }, []);

  const discard = () => {
    setEdits(new Map());
    setDeleted(new Set());
    setInserts([]);
  };

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey || e.ctrlKey) return;
      const k = e.key.toLowerCase();
      if (k === "s" && !e.shiftKey) {
        e.preventDefault();
        review();
      } else if (k === "r" && !e.shiftKey) {
        e.preventDefault();
        apply({}, true);
      } else if (k === "f" && !e.shiftKey && mode === "data") {
        e.preventDefault();
        toggleFilters();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const onEdit = useCallback((row: number, col: number, value: string | null) => {
    if (!data) return;
    const original = cellText(data, col, row);
    setEdits((m) => {
      const n = new Map(m);
      if (value === original) n.delete(editKey(row, col));
      else n.set(editKey(row, col), value);
      return n;
    });
  }, [data]);

  const sortBy = (column: string) => {
    const cur = opts.order_by;
    const next = cur?.column !== column ? { column, desc: false } : cur.desc ? null : { column, desc: true };
    apply({ order_by: next, offset: 0 });
  };

  const inspector = useMemo(() => {
    if (!data || selectedRow === null || selectedRow >= data.numRows) return null;
    return data.schema.fields.map((f, i) => {
      const k = editKey(selectedRow, i);
      const v = edits.has(k) ? edits.get(k)! : cellText(data, i, selectedRow);
      const col = structure?.columns.find((c) => c.name === f.name);
      const type = col?.data_type ?? "";
      // Re-indenting walks the text char by char; past ~1 MB that stalls the click.
      const pretty = v !== null && v.length < 1_000_000 && (/json/i.test(type) || !col) ? prettyJson(v) : null;
      return { name: f.name, type, value: v, shown: pretty ?? v, col: i };
    });
  }, [data, selectedRow, edits, structure]);

  const pageEnd = (result?.row_count ?? 0) + opts.offset;
  const hasNext = !!result && (total !== null ? pageEnd < total : result.row_count >= opts.limit);
  const resetKey = JSON.stringify(opts);

  const onInspectorDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX, startW = inspectorWidth;
    const move = (ev: MouseEvent) => {
      const w = Math.round(Math.max(220, Math.min(900, startW - (ev.clientX - startX))));
      lastInspectorWidth = w;
      setInspectorWidth(w);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("tv-col-resizing");
    };
    document.body.classList.add("tv-col-resizing");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div className="pane">
      <div className="toolbar">
        <div className="segmented">
          <button className={mode === "data" ? "on" : ""} onClick={() => setMode("data")}>Data</button>
          <button className={mode === "structure" ? "on" : ""} onClick={() => setMode("structure")}>Structure</button>
        </div>
        <span style={{ fontWeight: 600, marginLeft: 6 }}>{ref.schema !== "main" ? `${ref.schema}.` : ""}{ref.name}</span>
        {ref.kind === "view" && <span className="chip">view</span>}
        <div className="spacer" />
        {mode === "data" && (
          <>
            <button className={`icon-btn ${showFilters || opts.filters.length ? "on" : ""}`} title="Filter (⌘F)" onClick={toggleFilters}>
              <FilterIcon size={14} />{opts.filters.length ? opts.filters.length : ""}
            </button>
            {editable && <button className="icon-btn" title="Insert row" onClick={() => setInserting(true)}><Plus size={15} /></button>}
            {editable && (
              <button className="icon-btn" title="Delete selected rows" disabled={!selectedRows.length && selectedRow === null}
                onClick={() => toggleDeleted(selectedRows.length ? selectedRows : selectedRow !== null ? [selectedRow] : [])}>
                <Trash2 size={14} />
              </button>
            )}
            <button className="icon-btn" title="Refresh (⌘R)" onClick={() => apply({}, true)}><RefreshCw size={14} /></button>
          </>
        )}
      </div>
      {mode === "data" && showFilters && (
        <div className="filterbar" ref={filterBar} onKeyDown={(e) => {
          if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
            e.preventDefault();
            apply({ filters: draftFilters.filter((x) => x.column), offset: 0 });
          } else if (e.key === "Escape") {
            setShowFilters(false);
          }
        }}>
          {draftFilters.map((f, i) => (
            <div className="filter-row" key={i}>
              <select className="field" value={f.column} onChange={(e) => setDraftFilters((d) => d.map((x, j) => (j === i
                ? { ...x, column: e.target.value, op: e.target.value === ANY_COLUMN ? "contains" : x.op } : x)))}>
                <option value={ANY_COLUMN}>Any column</option>
                {structure?.columns.map((c) => <option key={c.name}>{c.name}</option>)}
              </select>
              <select className="field" value={f.op} disabled={f.column === ANY_COLUMN} onChange={(e) => setDraftFilters((d) => d.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)))}>
                {OPS.map((o) => <option key={o}>{o}</option>)}
              </select>
              {!f.op.includes("null") && (
                <input autoCapitalize="off" autoCorrect="off" spellCheck={false} className="field mono" style={{ flex: 1 }} placeholder={f.column === ANY_COLUMN ? "Search all columns" : "value"} value={f.value}
                  onChange={(e) => setDraftFilters((d) => d.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
              )}
              <button className="icon-btn" onClick={() => setDraftFilters((d) => d.filter((_, j) => j !== i))}><X size={13} /></button>
              {i === draftFilters.length - 1 && (
                <>
                  <button className="icon-btn" title="Add condition" onClick={() => setDraftFilters((d) => [...d, { column: structure?.columns[0]?.name ?? f.column, op: "=", value: "" }])}><Plus size={13} /></button>
                  <button className="btn primary" onClick={() => apply({ filters: draftFilters.filter((x) => x.column), offset: 0 })}>Apply</button>
                  {opts.filters.length > 0 && <button className="btn" onClick={() => { setDraftFilters([{ column: ANY_COLUMN, op: "contains", value: "" }]); apply({ filters: [], offset: 0 }); }}>Clear</button>}
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {mode === "structure" ? (
        <div className="structure">
          {structure && (
            <>
              <table className="plain">
                <thead><tr><th>#</th><th>column</th><th>type</th><th>nullable</th><th>default</th><th>key</th></tr></thead>
                <tbody>
                  {structure.columns.map((c, i) => (
                    <tr key={c.name}>
                      <td style={{ color: "var(--text-3)" }}>{i + 1}</td>
                      <td className="mono">{c.name}</td>
                      <td className="mono" style={{ color: "var(--text-2)" }}>{c.data_type}</td>
                      <td>{c.nullable ? "YES" : "NO"}</td>
                      <td className="mono" style={{ color: "var(--text-2)" }}>{c.default ?? ""}</td>
                      <td>
                        {[c.is_pk && "PRIMARY", c.is_fk && "FOREIGN"].filter(Boolean).join(", ")}
                        {c.references && <span className="mono" style={{ color: "var(--text-2)" }}> → {c.references.table}.{c.references.column}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="section-title">Indexes</div>
              <table className="plain">
                <thead><tr><th>name</th><th>columns</th><th>unique</th></tr></thead>
                <tbody>
                  {structure.indexes.map((x) => (
                    <tr key={x.name}><td className="mono">{x.name}</td><td className="mono">{x.columns.join(", ")}</td><td>{x.unique ? "YES" : ""}</td></tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      ) : (
        <div className="content">
          <div className="pane">
            {error && <div className="error-box">{error}</div>}
            <div className="grid-wrap">
              {data && (
                <DataGrid table={data} editable={editable} edits={edits} deleted={deleted} onEdit={onEdit}
                  onSelectRow={setSelectedRow} onSelectionRows={setSelectedRows} onDeleteRows={toggleDeleted}
                  sort={opts.order_by} onHeaderClick={sortBy} rowOffset={opts.offset} keyColumns={keyColumns} links={links} onFollowLink={followLink} layoutKey={`${connectionId}:${ref.schema}.${ref.name}`}
                  widthKey={`${connectionId}:${ref.schema}.${ref.name}`} resetKey={resetKey} search={false} />
              )}
            </div>
            <div className="statusbar">
              {loading && <div className="spinner" />}
              <span>
                {result ? `${result.row_count ? opts.offset + 1 : 0}–${pageEnd}` : ""}
                {total !== null ? ` of ${total.toLocaleString()} rows` : ""}
                {total === null && !counting && result && (estimate ?? 0) > AUTO_COUNT_LIMIT && (
                  <>
                    {" of "}
                    <button className="tv-link" title="Estimated by the database. Click to count exactly (reads the whole table)."
                      onClick={() => countNow(opts)}>
                      {opts.filters.length ? "? rows" : `≈ ${estimate!.toLocaleString()} rows`}
                    </button>
                  </>
                )}
                {total === null && counting ? " of … rows" : ""}
                {result ? ` · ${result.elapsed_ms} ms` : ""}
              </span>
              {!editable && structure && ref.kind === "table" && !readOnly && !structure.columns.some((c) => c.is_pk) && (
                <span title="Rows can only be edited in tables with a primary key">read-only (no primary key)</span>
              )}
              <div className="spacer" />
              {pending > 0 && (
                <>
                  <span className="pending">{pending} pending change{pending === 1 ? "" : "s"}</span>
                  <button className="btn" onClick={discard}>Discard</button>
                  <button className="btn primary" onClick={review}>Commit ⌘S</button>
                </>
              )}
              <select className="field" style={{ height: 20, fontSize: 11 }} value={opts.limit}
                onChange={(e) => apply({ limit: Number(e.target.value), offset: 0 })}>
                {PAGE_SIZES.map((n) => <option key={n} value={n}>{n.toLocaleString()} / page</option>)}
              </select>
              <button className="icon-btn" disabled={opts.offset === 0} onClick={() => apply({ offset: Math.max(0, opts.offset - opts.limit) })}><ChevronLeft size={14} /></button>
              <button className="icon-btn" disabled={!hasNext} onClick={() => apply({ offset: opts.offset + opts.limit })}><ChevronRight size={14} /></button>
            </div>
          </div>
          {inspector && (
            <>
            <div className="tv-col-handle" onMouseDown={onInspectorDrag} />
            <div className="inspector" style={{ width: inspectorWidth }}>
              <h4>Row {opts.offset + (selectedRow ?? 0) + 1}</h4>
              {inspector.map((f) => (
                <div className="insp-row" key={f.name}>
                  <div className="k">
                    <span>{f.name}</span>
                    <span style={{ display: "flex", gap: 6 }}>
                      <span className="mono" style={{ fontSize: 10 }}>{f.type}</span>
                      {editable && f.value !== null && (
                        <button className="icon-btn" style={{ height: 16, padding: "0 4px", fontSize: 10 }} onClick={() => onEdit(selectedRow!, f.col, null)}>NULL</button>
                      )}
                    </span>
                  </div>
                  <div className={`v tv-insp-value ${f.value === null ? "null" : ""}`}>{f.shown ?? "NULL"}</div>
                </div>
              ))}
            </div>
            </>
          )}
        </div>
      )}
      {preview && <CommitDialog statements={preview} onCancel={() => setPreview(null)} onCommit={commit} />}
      {inserting && structure && (
        <InsertDialog structure={structure} onCancel={() => setInserting(false)}
          onAdd={(row) => { setInserts((x) => [...x, row]); setInserting(false); }} />
      )}
    </div>
  );
}
