import { useEffect, useMemo, useRef, useState } from "react";
import { Eye, Table2 } from "lucide-react";
import { useStore } from "../store";
import type { TableRef } from "../types";
import "../nav.css";

interface Match { tier: number; rank: number; idx: number[] }

const range = (start: number, len: number) => Array.from({ length: len }, (_, i) => start + i);

/** Tiers: 0 exact, 1 prefix, 2 word start, 3 substring, 4 fuzzy subsequence. */
function match(needle: string, name: string): Match | null {
  if (!needle) return { tier: 0, rank: 0, idx: [] };
  const h = name.toLowerCase();
  if (h === needle) return { tier: 0, rank: 0, idx: range(0, needle.length) };
  if (h.startsWith(needle)) return { tier: 1, rank: 0, idx: range(0, needle.length) };
  for (let i = 1; i < h.length; i++) {
    const boundary = !/[a-z0-9]/.test(h[i - 1]) || (name[i] !== h[i] && name[i - 1] === h[i - 1]);
    if (boundary && h.startsWith(needle, i)) return { tier: 2, rank: i, idx: range(i, needle.length) };
  }
  const sub = h.indexOf(needle);
  if (sub >= 0) return { tier: 3, rank: sub, idx: range(sub, needle.length) };
  const idx: number[] = [];
  let pos = 0, gaps = 0;
  for (const ch of needle) {
    const i = h.indexOf(ch, pos);
    if (i < 0) return null;
    gaps += i - pos;
    idx.push(i);
    pos = i + 1;
  }
  return { tier: 4, rank: gaps, idx };
}

function Highlighted({ text, idx }: { text: string; idx: number[] }) {
  if (!idx.length) return <>{text}</>;
  const on = new Set(idx);
  return <>{[...text].map((ch, i) => (on.has(i) ? <b key={i}>{ch}</b> : ch))}</>;
}

export function QuickOpen() {
  const { schemas, activeConnectionId, openTable, set } = useStore();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const all: TableRef[] = useMemo(() => (activeConnectionId ? schemas[activeConnectionId]?.schemas.flatMap((g) => g.tables) ?? [] : []), [schemas, activeConnectionId]);
  const results = useMemo(() => {
    const n = q.toLowerCase().trim();
    return all
      .flatMap((t) => { const m = match(n, t.name); return m ? [{ t, m }] : []; })
      .sort((a, b) => a.m.tier - b.m.tier || a.m.rank - b.m.rank || a.t.name.length - b.t.name.length || a.t.name.localeCompare(b.t.name))
      .slice(0, 50);
  }, [all, q]);

  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    list.current?.querySelector(".quick-item.on")?.scrollIntoView({ block: "nearest" });
  }, [sel, results]);

  const close = () => set({ quickOpen: false });
  const choose = (t?: TableRef) => {
    if (!t) return;
    openTable(t);
    close();
  };

  return (
    <div className="modal-bg" style={{ paddingTop: 90 }} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal quick">
        <input autoCapitalize="off" autoCorrect="off" spellCheck={false} ref={input} className="quick-input" placeholder={activeConnectionId ? "Open table…" : "Connect to a database first"} value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
            else if (e.key === "ArrowDown") { e.preventDefault(); setSel((i) => Math.min(results.length - 1, i + 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSel((i) => Math.max(0, i - 1)); }
            else if (e.key === "Enter" && !e.nativeEvent.isComposing) choose(results[sel]?.t);
          }} />
        <div className="quick-list" ref={list}>
          {results.map(({ t, m }, i) => (
            <div key={`${t.schema}.${t.name}`} className={`quick-item ${i === sel ? "on" : ""}`} onMouseMove={() => i !== sel && setSel(i)} onClick={() => choose(t)}>
              {t.kind === "view" ? <Eye size={13} /> : <Table2 size={13} />}
              <span className="quick-name"><Highlighted text={t.name} idx={m.idx} /></span>
              <span className="quick-schema">{t.schema}</span>
            </div>
          ))}
          {results.length === 0 && <div className="quick-empty">{all.length === 0 ? "No tables" : `No tables match "${q.trim()}"`}</div>}
        </div>
      </div>
    </div>
  );
}
