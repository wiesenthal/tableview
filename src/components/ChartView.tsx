import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts";
import { DataType, Table } from "apache-arrow";
import { api, errorText } from "../api";
import { columnFormats, displayText, isIdColumn, Prefs } from "../prefs";
import { useStore } from "../store";
import type { VizKind, VizSpec } from "../types";
import { cellText } from "./DataGrid";

const KINDS: VizKind[] = ["bar", "line", "area", "scatter", "pie"];
const MAX_POINTS = 50_000;

function isNumeric(t: Table, name: string) {
  const f = t.schema.fields.find((x) => x.name === name);
  return !!f && (DataType.isInt(f.type) || DataType.isFloat(f.type) || (DataType.isUtf8(f.type) && looksNumeric(t, name)));
}

function looksNumeric(t: Table, name: string) {
  const i = t.schema.fields.findIndex((x) => x.name === name);
  for (let r = 0; r < Math.min(20, t.numRows); r++) {
    const v = cellText(t, i, r);
    if (v !== null && (v === "" || Number.isNaN(Number(v)))) return false;
  }
  return t.numRows > 0;
}

const isTime = (t: Table, name: string) => {
  const f = t.schema.fields.find((x) => x.name === name);
  return !!f && (DataType.isTimestamp(f.type) || DataType.isDate(f.type));
};

/** Time on x if there is one, else the first text column; numeric non-ID columns as values. */
export function guessSpec(t: Table): VizSpec {
  const names = t.schema.fields.map((f) => f.name);
  const nums = names.filter((n) => isNumeric(t, n));
  const x = names.find((n) => isTime(t, n)) ?? names.find((n) => !nums.includes(n)) ?? names[0];
  const values = nums.filter((n) => n !== x);
  const y = (values.some((n) => !isIdColumn(n)) ? values.filter((n) => !isIdColumn(n)) : values).slice(0, 2);
  return { kind: isTime(t, x) ? "line" : "bar", x, y: y.length ? y : [names.find((n) => n !== x) ?? names[0]] };
}

function css(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Oak first, then hues that stay distinct from it and from each other.
const PALETTE = ["#c07a3a", "#3f8f8a", "#7a9a3e", "#8a6bbf", "#d0574a", "#4f7fbf", "#d9a93f", "#8c6a4f"];

function buildOption(t: Table, spec: VizSpec, prefs: Prefs): echarts.EChartsOption {
  const idx = (n: string) => t.schema.fields.findIndex((f) => f.name === n);
  const xi = idx(spec.x);
  const xFormat = columnFormats([t.schema.fields[xi]].filter(Boolean))[0];
  const label = (v: string | number) => (typeof v === "string" && xFormat?.ts ? displayText(v, xFormat, prefs) : String(v));
  const n = Math.min(t.numRows, MAX_POINTS);
  const text = css("--text-2") || "#888";
  const grid = css("--border") || "rgba(128,128,128,.2)";
  const xs: string[] = [];
  for (let r = 0; r < n; r++) xs.push(cellText(t, xi, r) ?? "NULL");
  const num = (col: number, r: number) => {
    const v = cellText(t, col, r);
    return v === null ? null : Number(v);
  };
  const base: echarts.EChartsOption = {
    color: PALETTE,
    title: spec.title ? { text: spec.title, left: 12, top: 8, textStyle: { fontSize: 13, color: css("--text") } } : undefined,
    tooltip: {
      trigger: spec.kind === "pie" || spec.kind === "scatter" ? "item" : "axis",
      axisPointer: { label: { formatter: (p) => label(p.value as string | number) } },
    },
    legend: { bottom: 6, textStyle: { color: text }, type: "scroll" },
    animationDuration: 250,
  };
  if (spec.kind === "pie") {
    const yi = idx(spec.y[0]);
    return { ...base, series: [{ type: "pie", radius: ["38%", "68%"], itemStyle: { borderRadius: 4, borderColor: css("--bg"), borderWidth: 2 },
      label: { color: text }, data: xs.map((name, r) => ({ name: label(name), value: num(yi, r) ?? 0 })) }] };
  }
  const xNumeric = spec.kind === "scatter" && isNumeric(t, spec.x);
  let series: echarts.SeriesOption[];
  if (spec.series_by) {
    const si = idx(spec.series_by);
    const yi = idx(spec.y[0]);
    const groups = new Map<string, Map<string, number | null>>();
    const cats: string[] = [];
    const seen = new Set<string>();
    for (let r = 0; r < n; r++) {
      const g = cellText(t, si, r) ?? "NULL";
      if (!groups.has(g)) groups.set(g, new Map());
      groups.get(g)!.set(xs[r], num(yi, r));
      if (!seen.has(xs[r])) { seen.add(xs[r]); cats.push(xs[r]); }
    }
    series = [...groups].map(([name, m]) => ({
      name, type: spec.kind === "area" ? "line" : spec.kind, areaStyle: spec.kind === "area" ? { opacity: 0.25 } : undefined,
      stack: spec.kind === "area" ? "total" : undefined, showSymbol: false, data: cats.map((c) => m.get(c) ?? null),
    })) as echarts.SeriesOption[];
    xs.splice(0, xs.length, ...cats);
  } else {
    series = spec.y.map((y) => {
      const yi = idx(y);
      const data = Array.from({ length: n }, (_, r) => (spec.kind === "scatter" ? [xNumeric ? num(xi, r) : xs[r], num(yi, r)] : num(yi, r)));
      return {
        name: y, type: spec.kind === "area" ? "line" : spec.kind, data, showSymbol: n < 200,
        areaStyle: spec.kind === "area" ? { opacity: 0.25 } : undefined, large: n > 2000,
        itemStyle: spec.kind === "bar" ? { borderRadius: [3, 3, 0, 0] } : undefined,
      } as echarts.SeriesOption;
    });
  }
  return {
    ...base,
    grid: { left: 56, right: 24, top: spec.title ? 44 : 20, bottom: 56 },
    dataZoom: n > 60 ? [{ type: "inside" }] : undefined,
    xAxis: xNumeric
      ? { type: "value", axisLabel: { color: text }, splitLine: { lineStyle: { color: grid } } }
      : { type: "category", data: xs, axisLabel: { color: text, hideOverlap: true, formatter: (v: string) => label(v) }, axisLine: { lineStyle: { color: grid } } },
    yAxis: { type: "value", axisLabel: { color: text }, splitLine: { lineStyle: { color: grid } } },
    series,
  };
}

export function ChartCanvas({ table, spec }: { table: Table; spec: VizSpec }) {
  const prefs = useStore((s) => s.prefs);
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const option = useRef<echarts.EChartsOption | null>(null);
  // A chart opened in a background tab has no size yet. Lay it out only once
  // it is visible, and redraw from scratch whenever it goes from hidden to shown.
  const draw = useCallback(() => {
    const node = el.current;
    if (!node || !option.current || node.clientWidth === 0 || node.clientHeight === 0) return;
    if (!chart.current) chart.current = echarts.init(node, undefined, { renderer: "canvas" });
    chart.current.setOption(option.current, true);
    chart.current.resize();
  }, []);
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    let wasVisible = false;
    const ro = new ResizeObserver(() => {
      const visible = node.clientWidth > 0 && node.clientHeight > 0;
      if (visible && !wasVisible) draw();
      else if (visible) chart.current?.resize();
      wasVisible = visible;
    });
    ro.observe(node);
    return () => { ro.disconnect(); chart.current?.dispose(); chart.current = null; };
  }, [draw]);
  useEffect(() => {
    option.current = buildOption(table, spec, prefs);
    draw();
  }, [table, spec, prefs, draw]);
  return <div className="chart-host"><div ref={el} className="chart-canvas" /></div>;
}

export function ChartPanel({ table, spec, onChange }: { table: Table; spec: VizSpec; onChange: (s: VizSpec) => void }) {
  const names = table.schema.fields.map((f) => f.name);
  return (
    <div className="chart-layout">
      <ChartCanvas table={table} spec={spec} />
      <div className="chart-side">
        <label>Type
          <div className="chip-list">
            {KINDS.map((k) => <button key={k} className={`chip ${spec.kind === k ? "on" : ""}`} onClick={() => onChange({ ...spec, kind: k })}>{k}</button>)}
          </div>
        </label>
        <label>{spec.kind === "pie" ? "Labels" : "X axis"}
          <select className="field" value={spec.x} onChange={(e) => onChange({ ...spec, x: e.target.value })}>
            {names.map((n) => <option key={n}>{n}</option>)}
          </select>
        </label>
        <label>{spec.kind === "pie" ? "Value" : "Y values"}
          <div className="chip-list">
            {names.filter((n) => n !== spec.x).map((n) => (
              <button key={n} className={`chip ${spec.y.includes(n) ? "on" : ""}`}
                onClick={() => onChange({ ...spec, y: spec.y.includes(n) ? spec.y.filter((x) => x !== n) : [...spec.y, n] })}>{n}</button>
            ))}
          </div>
        </label>
        <label>Split series by
          <select className="field" value={spec.series_by ?? ""} onChange={(e) => onChange({ ...spec, series_by: e.target.value || null })}>
            <option value="">none</option>
            {names.filter((n) => n !== spec.x).map((n) => <option key={n}>{n}</option>)}
          </select>
        </label>
        {table.numRows > MAX_POINTS && <span style={{ fontSize: 11, color: "var(--text-2)" }}>Showing the first {MAX_POINTS.toLocaleString()} rows.</span>}
      </div>
    </div>
  );
}

export function ChartTab({ resultId, spec: initial }: { resultId: string; spec: VizSpec }) {
  const [table, setTable] = useState<Table | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [spec, setSpec] = useState(initial);
  useEffect(() => {
    api.resultTable(resultId).then(setTable).catch((e) => setError(errorText(e)));
  }, [resultId]);
  const content = useMemo(() => table && <ChartPanel table={table} spec={spec} onChange={setSpec} />, [table, spec]);
  return (
    <div className="pane">
      {error && <div className="error-box">{error}</div>}
      {content}
    </div>
  );
}
