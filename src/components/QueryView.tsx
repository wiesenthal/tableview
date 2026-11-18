import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror, { EditorView, keymap, ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { sql as sqlLang, PostgreSQL, MySQL, SQLite } from "@codemirror/lang-sql";
import { Prec } from "@codemirror/state";
import type { Table } from "apache-arrow";
import { BarChart3, Play, Sparkles, Square } from "lucide-react";
import { api, errorText } from "../api";
import { newId, useStore } from "../store";
import type { DbKind, QueryResult, VizSpec } from "../types";
import { ChartPanel, guessSpec } from "./ChartView";
import { DataGrid, sortedRows, useDark } from "./DataGrid";
import "../grid.css";

type Stmt = { from: number; to: number; text: string };

/** Splits a script on top-level semicolons, skipping strings, quoted identifiers, comments and dollar quotes. */
function splitStatements(doc: string, dialect: DbKind): Stmt[] {
  const out: Stmt[] = [];
  let start = 0;
  let code = false;
  const push = (end: number) => {
    if (code) {
      let a = start, b = end;
      while (a < b && /\s/.test(doc[a])) a++;
      while (b > a && /\s/.test(doc[b - 1])) b--;
      out.push({ from: a, to: b, text: doc.slice(a, b) });
    }
    start = end + 1;
    code = false;
  };
  const n = doc.length;
  let i = 0;
  while (i < n) {
    const c = doc[i];
    const next = doc[i + 1];
    if (c === "-" && next === "-" || c === "#" && dialect === "mysql") {
      while (i < n && doc[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (doc[i] === "*" && doc[i + 1] === "/") { depth--; i += 2; }
        else if (dialect === "postgres" && doc[i] === "/" && doc[i + 1] === "*") { depth++; i += 2; }
        else i++;
      }
      continue;
    }
    if (c === ";") { push(i); i++; continue; }
    if (!/\s/.test(c)) code = true;
    if (c === "'" || c === '"' || (c === "`" && dialect !== "postgres")) {
      const backslash = c !== "`" && (dialect === "mysql" || (c === "'" && dialect === "postgres" && /[eE]/.test(doc[i - 1] ?? "") && !/\w/.test(doc[i - 2] ?? "")));
      i++;
      while (i < n) {
        if (backslash && doc[i] === "\\") { i += 2; continue; }
        if (doc[i] === c) {
          if (doc[i + 1] === c) { i += 2; continue; }
          break;
        }
        i++;
      }
      i++;
      continue;
    }
    if (c === "$" && dialect === "postgres" && !/[\w$]/.test(doc[i - 1] ?? "")) {
      const m = /^\$([A-Za-z_\u0080-￿][\w\u0080-￿]*)?\$/.exec(doc.slice(i, i + 64));
      if (m) {
        const close = doc.indexOf(m[0], i + m[0].length);
        i = close < 0 ? n : close + m[0].length;
        continue;
      }
    }
    i++;
  }
  push(n);
  return out;
}

/** The statement the cursor is in, or the closest one before it. */
function statementAt(doc: string, pos: number, dialect: DbKind): Stmt | null {
  const all = splitStatements(doc, dialect);
  if (!all.length) return null;
  let best = all[0];
  for (const s of all) {
    if (s.from <= pos) best = s;
    else break;
  }
  return best;
}

/** psql-style pointer at the error position, which Postgres counts in characters of the submitted text. */
function errorWithPosition(view: EditorView, message: string, sent: string, from: number, position: number, moveCursor: boolean): string {
  const offset = from + Array.from(sent).slice(0, position - 1).join("").length;
  const line = view.state.doc.lineAt(Math.min(offset, view.state.doc.length));
  if (moveCursor) view.dispatch({ selection: { anchor: line.from + Math.min(offset - line.from, line.length) }, scrollIntoView: true });
  const col = offset - line.from;
  const label = `LINE ${line.number}: `;
  if (line.length > 240) return `${message}\nLINE ${line.number}, column ${col + 1}`;
  return `${message}\n${label}${line.text}\n${" ".repeat(label.length + col)}^`;
}

let lastEditorHeight: number | null = null;

/** Columns of tables named in the SQL, fetched on demand for autocomplete. */
const columnCache = new Map<string, string[] | Promise<void>>();

export function QueryView({ tabId, connectionId, initialSql, resultId, active, fromClaude }: {
  tabId: string; connectionId: string; initialSql: string; resultId?: string; active: boolean; fromClaude?: boolean;
}) {
  const { updateTab, notify, connections, schemas } = useStore();
  const conn = connections.find((c) => c.id === connectionId);
  const kind: DbKind = conn?.kind ?? "postgres";
  const [sql, setSql] = useState(initialSql);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [data, setData] = useState<Table | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [chart, setChart] = useState<VizSpec | null>(null);
  const [sort, setSort] = useState<{ column: string; desc: boolean } | null>(null);
  const [editorHeight, setEditorHeight] = useState<number | null>(lastEditorHeight);
  const [columnsVersion, setColumnsVersion] = useState(0);
  /** Run to first rows drawn: query, transfer, Arrow decode and the grid's first paint. */
  const [shownMs, setShownMs] = useState<number | null>(null);
  const editor = useRef<ReactCodeMirrorRef>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const dark = useDark();

  const show = useCallback(async (id: string) => {
    const [meta, t] = await Promise.all([api.resultMeta(id), api.resultTable(id)]);
    setResult(meta);
    setData(t);
    setSort(null);
  }, []);

  // Sorted here, not by re-running the query: the SQL may not take an ORDER BY and could have side effects.
  const rowOrder = useMemo(() => (data && sort ? sortedRows(data, sort.column, sort.desc) : undefined), [data, sort]);
  const sortBy = useCallback((column: string) => {
    setSort((cur) => (cur?.column !== column ? { column, desc: false } : cur.desc ? null : { column, desc: true }));
  }, []);

  useEffect(() => {
    if (resultId) show(resultId).catch((e) => setError(errorText(e)));
  }, [resultId, show]);

  const run = async (all: boolean) => {
    const view = editor.current?.view;
    if (running || !view) return;
    const doc = view.state.doc.toString();
    const sel = view.state.selection.main;
    let text = doc, from = 0;
    const fromSelection = !all && !sel.empty;
    if (!all && !sel.empty) {
      text = view.state.sliceDoc(sel.from, sel.to);
      from = sel.from;
    } else if (!all) {
      const st = statementAt(doc, sel.head, kind);
      if (!st) return;
      ({ text, from } = st);
    }
    if (!text.trim()) return;
    const qid = newId("q");
    setRunning(qid);
    setError(null);
    setShownMs(null);
    const started = performance.now();
    try {
      const r = await api.runQuery(connectionId, tabId, text, qid);
      const prev = resultId;
      updateTab(tabId, { resultId: r.id, sql: doc });
      if (prev && prev !== r.id) api.releaseResult(prev).catch(() => {});
      await show(r.id);
      requestAnimationFrame(() => requestAnimationFrame(() => setShownMs(Math.round(performance.now() - started))));
      if (r.rows_affected !== null && r.columns.length === 0) notify(`${r.rows_affected} row${r.rows_affected === 1 ? "" : "s"} affected`);
      if (/^\s*(create|drop|alter)\b/im.test(text)) useStore.getState().refreshSchema();
    } catch (e) {
      const position = (e as { position?: number | null })?.position;
      setError(position && editor.current?.view ? errorWithPosition(editor.current.view, errorText(e), text, from, position, !fromSelection) : errorText(e));
    } finally {
      setRunning(null);
    }
  };
  const runRef = useRef(run);
  runRef.current = run;

  const keys = useMemo(() => Prec.highest(keymap.of([
    { key: "Mod-Enter", run: () => { runRef.current(false); return true; } },
    { key: "Mod-Shift-Enter", run: () => { runRef.current(true); return true; } },
  ])), []);

  const tree = schemas[connectionId];
  const tableNames = useMemo(() => {
    const out = new Map<string, string>();
    tree?.schemas.forEach((g) => g.tables.forEach((t) => {
      if (!out.has(t.name.toLowerCase())) out.set(t.name.toLowerCase(), `${g.name}\u0000${t.name}`);
    }));
    return out;
  }, [tree]);

  const referenced = useMemo(() => {
    const names: string[] = [];
    for (const m of sql.matchAll(/\b(?:from|join|update|into|table)\s+(?:[`"]?\w+[`"]?\.)?[`"]?(\w+)/gi)) {
      const key = tableNames.get(m[1].toLowerCase());
      if (key && !names.includes(key)) names.push(key);
    }
    return names;
  }, [sql, tableNames]);
  const referencedKey = referenced.join("\u0001");

  useEffect(() => {
    const t = setTimeout(() => {
      for (const key of referenced) {
        const cacheKey = `${connectionId}\u0000${key}`;
        if (columnCache.has(cacheKey)) continue;
        const [schema, name] = key.split("\u0000");
        columnCache.set(cacheKey, api.describeTable(connectionId, schema, name)
          .then((st) => { columnCache.set(cacheKey, st.columns.map((c) => c.name)); setColumnsVersion((v) => v + 1); })
          .catch(() => { columnCache.delete(cacheKey); }));
      }
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [referencedKey, connectionId]);

  const language = useMemo(() => {
    const schema: Record<string, string[]> = {};
    tableNames.forEach((key, lower) => {
      const cols = columnCache.get(`${connectionId}\u0000${key}`);
      schema[key.split("\u0000")[1] ?? lower] = Array.isArray(cols) ? cols : [];
    });
    const first = referenced[0]?.split("\u0000")[1];
    const dialect = kind === "mysql" ? MySQL : kind === "sqlite" ? SQLite : PostgreSQL;
    return sqlLang({ dialect, schema, defaultTable: first, upperCaseKeywords: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableNames, referencedKey, columnsVersion, connectionId, kind]);

  const extensions = useMemo(() => [language, keys, EditorView.lineWrapping], [language, keys]);
  const basicSetup = useMemo(() => ({ highlightActiveLine: true, foldGutter: false, autocompletion: true }), []);
  const onChange = useCallback((v: string) => setSql(v), []);
  useEffect(() => {
    // Kept in the store so pinned tabs and the restored session have the latest text.
    const t = setTimeout(() => {
      if (useStore.getState().tabs.find((x) => x.id === tabId && x.kind === "query" && x.sql !== sql)) updateTab(tabId, { sql });
    }, 400);
    return () => clearTimeout(t);
  }, [sql, tabId, updateTab]);

  useEffect(() => {
    if (active) setTimeout(() => editor.current?.view?.focus(), 30);
  }, [active]);

  const onSplitDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const pane = paneRef.current;
    const host = (e.currentTarget as HTMLElement).previousElementSibling as HTMLElement | null;
    if (!pane || !host) return;
    const top = host.getBoundingClientRect().top;
    const max = pane.getBoundingClientRect().bottom - top - 80;
    const move = (ev: MouseEvent) => {
      const h = Math.round(Math.max(80, Math.min(max, ev.clientY - top)));
      lastEditorHeight = h;
      setEditorHeight(h);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("tv-row-resizing");
    };
    document.body.classList.add("tv-row-resizing");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div className="pane" ref={paneRef}>
      <div className="toolbar">
        {running ? (
          <button className="btn" onClick={() => api.cancelQuery(running).then((ok) => !ok && notify("This database cannot cancel queries"))}>
            <Square size={11} style={{ marginRight: 4 }} />Stop
          </button>
        ) : (
          <button className="btn primary" onClick={() => run(false)} title="Run statement or selection (⌘↵). Run all: ⇧⌘↵">
            <Play size={11} style={{ marginRight: 4 }} />Run
          </button>
        )}
        {fromClaude && <span className="chip" style={{ display: "inline-flex", gap: 4, alignItems: "center" }}><Sparkles size={11} />from Claude</span>}
        <div className="spacer" />
        <button className={`icon-btn ${chart ? "on" : ""}`} disabled={!data || !data.numRows} title="Chart this result"
          onClick={() => setChart(chart ? null : data ? guessSpec(data) : null)}>
          <BarChart3 size={15} />
        </button>
      </div>
      <div className="editor" style={editorHeight ? { height: editorHeight, minHeight: 80, borderBottom: 0 } : { borderBottom: 0 }}>
        <div className="editor-host">
          <CodeMirror ref={editor} value={sql} height="100%" theme={dark ? "dark" : "light"}
            extensions={extensions} basicSetup={basicSetup} onChange={onChange} />
        </div>
      </div>
      <div className="tv-split-handle" onMouseDown={onSplitDrag} />
      {error && <div className="error-box">{error}</div>}
      <div className="content">
        <div className="pane">
          <div className="grid-wrap">
            {data && !chart && data.numCols > 0 && <DataGrid table={data} widthKey={`query:${tabId}`}
              sort={sort} onHeaderClick={sortBy} rowOrder={rowOrder} resetKey={rowOrder ?? data} />}
            {data && chart && <ChartPanel table={data} spec={chart} onChange={setChart} />}
            {!data && !error && !running && <div className="empty">⌘↵ runs the statement under the cursor</div>}
          </div>
          <div className="statusbar">
            {running && <div className="spinner" />}
            {result && (
              <span>
                {result.columns.length ? `${result.row_count.toLocaleString()} rows` : `${result.rows_affected ?? 0} rows affected`}
                {result.truncated && (
                  <span title="Results stop at 10 million rows or 1 GB of data, whichever comes first. Add a LIMIT or WHERE to see other rows.">
                    {" (truncated at the result size limit)"}
                  </span>
                )}
                <span title="Query: the database plus decoding in TableView. On screen: from Run until the first rows were drawn.">
                  {" · "}{result.elapsed_ms} ms query{shownMs !== null && ` · ${shownMs} ms to screen`}
                </span>
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
