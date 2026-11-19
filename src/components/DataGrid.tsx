import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DataEditor, {
  CellClickedEventArgs, CompactSelection, DataEditorRef, DrawCellCallback, EditableGridCell, GridCell, GridCellKind, GridColumn,
  GridMouseEventArgs, GridSelection, Item, Rectangle, Theme,
} from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import "../grid.css";
import { DataType, Table } from "apache-arrow";
import { cellPreview, cellText } from "../cells";
import { columnFormats, displayText } from "../prefs";
import { useStore } from "../store";

export { cellPreview, cellText } from "../cells";

const collator = new Intl.Collator(undefined, { numeric: true });

/**
 * Row order for sorting a result in memory by one column, like ORDER BY: NULLs
 * sort as the largest value. Text columns whose values are all numbers (decimals
 * arrive as text) sort numerically.
 */
export function sortedRows(table: Table, column: string, desc: boolean): Int32Array {
  const col = table.schema.fields.findIndex((f) => f.name === column);
  const vec = table.getChildAt(col);
  const n = table.numRows;
  const rows = Array.from({ length: n }, (_, i) => i);
  if (!vec) return Int32Array.from(rows);
  let keys: unknown[] = Array.from({ length: n }, (_, i) => vec.get(i));
  if (DataType.isUtf8(vec.type)) {
    const nums = keys.map((v) => (v === null || v === undefined || v === "" ? null : Number(v)));
    if (nums.every((v, i) => v === null ? keys[i] === null || keys[i] === undefined : Number.isFinite(v))) keys = nums;
  }
  const dir = desc ? -1 : 1;
  rows.sort((a, b) => {
    const x = keys[a], y = keys[b];
    const xn = x === null || x === undefined, yn = y === null || y === undefined;
    if (xn || yn) return xn === yn ? 0 : (xn ? 1 : -1) * dir;
    if (typeof x === "string" && typeof y === "string") return collator.compare(x, y) * dir;
    return ((x as number) < (y as number) ? -1 : (x as number) > (y as number) ? 1 : 0) * dir;
  });
  return Int32Array.from(rows);
}

export function useDark() {
  const q = useMemo(() => window.matchMedia("(prefers-color-scheme: dark)"), []);
  const [dark, setDark] = useState(q.matches);
  useEffect(() => {
    const f = (e: MediaQueryListEvent) => setDark(e.matches);
    q.addEventListener("change", f);
    return () => q.removeEventListener("change", f);
  }, [q]);
  return dark;
}

function gridTheme(dark: boolean): Partial<Theme> {
  const base = {
    fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
    headerFontStyle: "600 11.5px",
    baseFontStyle: "12px",
    editorFontSize: "12px",
    cellHorizontalPadding: 8,
    // polished oak, matching --accent
    accentColor: dark ? "#c07a3a" : "#a8612a",
    accentLight: dark ? "rgba(201,132,67,0.26)" : "rgba(168,97,42,0.13)",
  };
  return dark
    ? {
        ...base, bgCell: "#1e1e1f", bgCellMedium: "#232325", bgHeader: "#262628", bgHeaderHasFocus: "#2e2e30",
        bgHeaderHovered: "#2e2e30", textDark: "#f2f2f7", textMedium: "#a1a1a6", textLight: "#6e6e73",
        textHeader: "#a1a1a6", borderColor: "rgba(255,255,255,0.08)", horizontalBorderColor: "rgba(255,255,255,0.06)",
        bgBubble: "#2c2c2e", textBubble: "#f2f2f7", bgSearchResult: "rgba(255,204,0,0.3)",
      }
    : {
        ...base, bgCell: "#ffffff", bgCellMedium: "#fafafa", bgHeader: "#f6f6f7", bgHeaderHasFocus: "#ececee",
        bgHeaderHovered: "#ececee", textDark: "#1d1d1f", textMedium: "#6e6e73", textLight: "#a1a1a6",
        textHeader: "#6e6e73", borderColor: "rgba(0,0,0,0.09)", horizontalBorderColor: "rgba(0,0,0,0.06)",
      };
}

/** Width at a link cell's right edge that holds the foreign key arrow and follows it on click. */
const LINK_HIT = 22;

export const editKey =(row: number, col: number) => `${row}:${col}`;

const EMPTY_SELECTION: GridSelection = { columns: CompactSelection.empty(), rows: CompactSelection.empty() };

/** Column widths the user dragged, per table, for the rest of the session. */
const resizedWidths = new Map<string, Record<string, number>>();

type Layout = { order?: string[]; widths?: Record<string, number> };

function loadLayout(key: string): Layout {
  try {
    return JSON.parse(localStorage.getItem(`tv.layout.${key}`) ?? "{}") as Layout;
  } catch {
    return {};
  }
}

function saveLayout(key: string, layout: Layout) {
  try {
    if (!layout.order?.length && !Object.keys(layout.widths ?? {}).length) localStorage.removeItem(`tv.layout.${key}`);
    else localStorage.setItem(`tv.layout.${key}`, JSON.stringify(layout));
  } catch {
    /* storage unavailable: the layout lasts for this session only */
  }
}

/** Display order as field indices: saved names that still exist, then any new columns. */
function resolveOrder(names: string[], saved: string[] | undefined): number[] {
  const index = new Map(names.map((n, i) => [n, i]));
  const out = (saved ?? []).filter((n) => index.has(n)).map((n) => index.get(n)!);
  const used = new Set(out);
  names.forEach((_, i) => { if (!used.has(i)) out.push(i); });
  return out;
}

function selectedCells(sel: GridSelection): { col: number; row: number }[] {
  const out: { col: number; row: number }[] = [];
  const seen = new Set<string>();
  for (const r of sel.current ? [sel.current.range, ...sel.current.rangeStack] : []) {
    for (let row = r.y; row < r.y + r.height; row++) {
      for (let col = r.x; col < r.x + r.width; col++) {
        const k = editKey(row, col);
        if (!seen.has(k)) { seen.add(k); out.push({ col, row }); }
      }
    }
  }
  return out;
}

export interface GridProps {
  table: Table;
  editable?: boolean;
  edits?: Map<string, string | null>;
  deleted?: Set<number>;
  onEdit?: (row: number, col: number, value: string | null) => void;
  onSelectRow?: (row: number | null) => void;
  onSelectionRows?: (rows: number[]) => void;
  /** Delete pressed with whole rows selected. */
  onDeleteRows?: (rows: number[]) => void;
  sort?: { column: string; desc: boolean } | null;
  onHeaderClick?: (column: string) => void;
  rowOffset?: number;
  /** Display row to table row, for a read-only grid sorted in memory. */
  rowOrder?: Int32Array;
  /** Primary and foreign key column names, shortened like ID columns. */
  keyColumns?: Set<string>;
  /** Foreign key columns: hovering a value shows an arrow that follows the key. */
  links?: ReadonlyMap<string, unknown>;
  onFollowLink?: (column: string, value: string) => void;
  /** Remembers resized column widths under this key for the session. */
  widthKey?: string;
  /** Saves column order and widths under this key across restarts (dragged headers stay put). */
  layoutKey?: string;
  /** Selection and scroll reset when this changes; a new `table` with the same key keeps them. Defaults to `table`. */
  resetKey?: unknown;
  /** Glide's own ⌘F search. Off where ⌘F means something else. */
  search?: boolean;
}

export function DataGrid({
  table, editable, edits, deleted, onEdit, onSelectRow, onSelectionRows, onDeleteRows, sort, onHeaderClick, rowOffset = 0, rowOrder, keyColumns,
  links, onFollowLink, widthKey, layoutKey, resetKey, search = true,
}: GridProps) {
  const prefs = useStore((s) => s.prefs);
  const formats = useMemo(() => columnFormats(table.schema.fields, keyColumns), [table, keyColumns]);
  const shown = useCallback((col: number, text: string) => displayText(text, formats[col], prefs), [formats, prefs]);
  const dark = useDark();
  const theme = useMemo(() => gridTheme(dark), [dark]);
  const [widths, setWidths] = useState<Record<string, number>>(
    () => (layoutKey && loadLayout(layoutKey).widths) || (widthKey && resizedWidths.get(widthKey)) || {},
  );
  const [savedOrder, setSavedOrder] = useState<string[] | undefined>(() => (layoutKey ? loadLayout(layoutKey).order : undefined));
  const names = useMemo(() => table.schema.fields.map((f) => f.name), [table]);
  /** order[displayColumn] = field index in the Arrow table. */
  const order = useMemo(() => resolveOrder(names, savedOrder), [names, savedOrder]);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [selection, setSelection] = useState<GridSelection>(EMPTY_SELECTION);
  const grid = useRef<DataEditorRef>(null);
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onSelectRow, onSelectionRows });
  callbacks.current = { onSelectRow, onSelectionRows };

  const publish = useCallback((s: GridSelection) => {
    setSelection(s);
    callbacks.current.onSelectRow?.(s.current?.cell[1] ?? s.rows.first() ?? null);
    callbacks.current.onSelectionRows?.(s.rows.toArray());
  }, []);

  const resetOn = resetKey ?? table;
  useEffect(() => {
    publish(EMPTY_SELECTION);
    grid.current?.scrollTo(0, 0);
  }, [resetOn, publish]);

  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  useEffect(() => {
    const s = selectionRef.current;
    if ((s.current?.cell[1] ?? -1) >= table.numRows || (s.rows.last() ?? -1) >= table.numRows) publish(EMPTY_SELECTION);
  }, [table, publish]);

  const autoWidths = useMemo(() => table.schema.fields.map((f, i) => {
    let longest = f.name.length + 3;
    const n = Math.min(table.numRows, 80);
    for (let r = 0; r < n; r++) {
      const t = cellPreview(table, i, r).text;
      longest = Math.max(longest, Math.min(t === null ? 4 : shown(i, t).length, 44));
    }
    return Math.round(Math.max(64, Math.min(340, longest * 7.3 + 20)));
  }), [table, shown]);

  const columns: GridColumn[] = useMemo(() => order.map((i) => {
    const f = table.schema.fields[i];
    const arrow = sort?.column === f.name ? (sort.desc ? " ↓" : " ↑") : "";
    return { title: f.name + arrow, id: f.name, width: widths[f.name] ?? autoWidths[i] };
  }), [table, order, widths, autoWidths, sort]);

  const persist = useCallback((layout: Layout) => {
    if (layoutKey) saveLayout(layoutKey, layout);
  }, [layoutKey]);

  const onColumnResize = useCallback((c: GridColumn, w: number) => {
    setWidths((s) => {
      const next = { ...s, [c.id!]: w };
      if (widthKey) resizedWidths.set(widthKey, next);
      persist({ order: savedOrder, widths: next });
      return next;
    });
  }, [widthKey, persist, savedOrder]);

  const onColumnMoved = useCallback((from: number, to: number) => {
    const next = order.map((i) => names[i]);
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setSavedOrder(next);
    persist({ order: next, widths });
    publish(EMPTY_SELECTION);
  }, [order, names, persist, widths, publish]);

  const resetLayout = useCallback((what: "order" | "all") => {
    setSavedOrder(undefined);
    if (what === "all") {
      setWidths({});
      if (widthKey) resizedWidths.delete(widthKey);
    }
    persist({ order: undefined, widths: what === "all" ? {} : widths });
    publish(EMPTY_SELECTION);
    setMenu(null);
  }, [persist, widths, widthKey, publish]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  // Glide quotes copied text like a spreadsheet; one cell copies as its exact value.
  useEffect(() => {
    const onCopy = (e: ClipboardEvent) => {
      const el = document.activeElement;
      if (!host.current?.contains(el) || el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return;
      const cur = selection.current;
      if (!cur || cur.rangeStack.length || cur.range.width !== 1 || cur.range.height !== 1 || selection.rows.length || selection.columns.length) return;
      const [dcol, drow] = cur.cell;
      const col = order[dcol];
      const row = rowOrder ? rowOrder[drow] : drow;
      const k = editKey(row, col);
      const value = edits?.has(k) ? edits.get(k)! : cellText(table, col, row);
      e.clipboardData?.setData("text/plain", value ?? "NULL");
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("copy", onCopy, true);
    return () => window.removeEventListener("copy", onCopy, true);
  }, [selection, table, edits, order, rowOrder]);

  const focused = selection.current?.cell;
  const focusedKey = focused ? editKey(rowOrder ? rowOrder[focused[1]] : focused[1], order[focused[0]]) : null;

  /** `full` decodes large values completely: needed to edit or copy them, not to draw them. */
  const cellContent = useCallback(([dcol, drow]: Item, full: boolean): GridCell => {
    const col = order[dcol] as number | undefined;
    const row = (rowOrder ? rowOrder[drow] : drow) as number | undefined;
    // The grid can ask for a cell the current result doesn't have (a stale row
    // order or row count for one render after the data changes): draw it empty.
    if (col === undefined || row === undefined || row < 0 || row >= table.numRows) {
      return { kind: GridCellKind.Text, data: "", displayData: "", allowOverlay: false, readonly: true };
    }
    const k = editKey(row, col);
    const edited = edits?.has(k) ?? false;
    let value: string | null;
    let large = false;
    if (edited) value = edits!.get(k)!;
    else if (full || k === focusedKey) value = cellText(table, col, row);
    else ({ text: value, large } = cellPreview(table, col, row));
    const isNull = value === null;
    const isDeleted = deleted?.has(row) ?? false;
    return {
      kind: GridCellKind.Text,
      data: value ?? "",
      copyData: value ?? "NULL",
      displayData: value === null ? "NULL" : large || value.length > 500 ? value.slice(0, 500) + "…" : edited ? value : shown(col, value),
      allowOverlay: true,
      readonly: !editable || isDeleted,
      themeOverride: {
        ...(isNull ? { textDark: dark ? "#6e6e73" : "#a1a1a6" } : {}),
        ...(edited ? { bgCell: dark ? "#4a4020" : "#fff4c2" } : {}),
        ...(isDeleted ? { bgCell: dark ? "#4a2420" : "#ffe1de", textDark: dark ? "#a1a1a6" : "#8e8e93" } : {}),
      },
    };
  }, [table, edits, deleted, editable, dark, shown, order, rowOrder, focusedKey]);

  const getCellContent = useCallback((item: Item) => cellContent(item, false), [cellContent]);
  // Copy goes through here, so large values copy whole even though they are drawn truncated.
  const getCellsForSelection = useCallback((r: Rectangle) => {
    const out: GridCell[][] = [];
    for (let y = r.y; y < r.y + r.height; y++) {
      const line: GridCell[] = [];
      for (let x = r.x; x < r.x + r.width; x++) line.push(cellContent([x, y], true));
      out.push(line);
    }
    return out;
  }, [cellContent]);

  /** The foreign key value at a display cell, or null when it isn't a link (or is NULL). */
  const linkValue = useCallback(([dcol, drow]: Item): string | null => {
    const col = order[dcol] as number | undefined;
    const row = (rowOrder ? rowOrder[drow] : drow) as number | undefined;
    if (!links?.size || col === undefined || row === undefined || row < 0 || row >= table.numRows) return null;
    if (!links.has(names[col]) || deleted?.has(row)) return null;
    const k = editKey(row, col);
    return edits?.has(k) ? edits.get(k)! : cellText(table, col, row);
  }, [links, order, rowOrder, names, table, edits, deleted]);

  // The hovered cell is drawn with the link arrow; Glide doesn't redraw text cells on hover, so damage them.
  const hovered = useRef<Item | null>(null);
  const onItemHovered = useCallback((args: GridMouseEventArgs) => {
    const prev = hovered.current;
    const next = args.kind === "cell" ? args.location : null;
    if (prev?.[0] === next?.[0] && prev?.[1] === next?.[1]) return;
    hovered.current = next;
    if (!links?.size) return;
    grid.current?.updateCells([prev, next].filter((c): c is Item => !!c).map((cell) => ({ cell })));
  }, [links]);

  const drawCell = useCallback<DrawCellCallback>((args, drawContent) => {
    drawContent();
    const h = hovered.current;
    if (!h || h[0] !== args.col || h[1] !== args.row || linkValue([args.col, args.row]) === null) return;
    const { ctx, rect, theme: t } = args;
    const r = 7, cx = rect.x + rect.width - LINK_HIT / 2, cy = rect.y + rect.height / 2;
    ctx.save();
    ctx.fillStyle = t.accentColor;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(cx - 3.5, cy);
    ctx.lineTo(cx + 3.5, cy);
    ctx.moveTo(cx + 0.5, cy - 3);
    ctx.lineTo(cx + 3.5, cy);
    ctx.lineTo(cx + 0.5, cy + 3);
    ctx.stroke();
    ctx.restore();
  }, [linkValue]);

  const onCellClicked = useCallback((cell: Item, e: CellClickedEventArgs) => {
    if (e.localEventX < e.bounds.width - LINK_HIT) return;
    const value = linkValue(cell);
    if (value === null) return;
    e.preventDefault();
    onFollowLink?.(names[order[cell[0]]], value);
  }, [linkValue, onFollowLink, names, order]);

  const onCellEdited = useCallback(([dcol, row]: Item, cell: EditableGridCell) => {
    if (cell.kind !== GridCellKind.Text) return;
    onEdit?.(row, order[dcol], cell.data);
  }, [onEdit, order]);

  const onDelete = useCallback((sel: GridSelection) => {
    if (!editable || !onEdit) return false;
    if (!sel.current && sel.rows.length) {
      onDeleteRows?.(sel.rows.toArray());
      return false;
    }
    for (const { col, row } of selectedCells(sel)) {
      if (!deleted?.has(row)) onEdit(row, order[col], null);
    }
    return false;
  }, [editable, onEdit, onDeleteRows, deleted, order]);

  return (
    <div ref={host} className="tv-grid-host">
    <DataEditor
      ref={grid}
      theme={theme}
      columns={columns}
      rows={table.numRows}
      getCellContent={getCellContent}
      onCellEdited={editable ? onCellEdited : undefined}
      onDelete={onDelete}
      getCellsForSelection={getCellsForSelection}
      onItemHovered={onItemHovered}
      drawCell={links?.size ? drawCell : undefined}
      onCellClicked={links?.size ? onCellClicked : undefined}
      onColumnResize={onColumnResize}
      maxColumnWidth={1200}
      cellActivationBehavior="double-click"
      onHeaderClicked={(i) => onHeaderClick?.(names[order[i]])}
      onColumnMoved={onColumnMoved}
      onHeaderContextMenu={(_, e) => {
        e.preventDefault();
        const r = host.current?.getBoundingClientRect();
        setMenu({ x: e.bounds.x + e.localEventX - (r?.left ?? 0), y: e.bounds.y + e.localEventY - (r?.top ?? 0) });
      }}
      gridSelection={selection}
      onGridSelectionChange={publish}
      rowMarkers={{ kind: "clickable-number", startIndex: rowOffset + 1, width: Math.max(44, String(rowOffset + table.numRows).length * 8 + 18) }}
      rowHeight={24}
      headerHeight={28}
      smoothScrollX
      smoothScrollY
      width="100%"
      height="100%"
      keybindings={{ search, copy: true, paste: false }}
    />
    {menu && (
      <div className="tv-menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
        <button disabled={!savedOrder} onClick={() => resetLayout("order")}>Reset column order</button>
        <button onClick={() => resetLayout("all")}>Reset column order and widths</button>
      </div>
    )}
    </div>
  );
}
