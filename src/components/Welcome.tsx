import appIcon from "../assets/app-icon.png";
import { useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { Database, Keyboard, Pencil, Plus, Settings, Sparkles, MessageSquarePlus } from "lucide-react";
import { ENV_COLORS, useStore } from "../store";
import type { ConnectionConfig } from "../types";
import "../nav.css";

const KIND_STYLE = {
  postgres: { bg: "#336791", label: "Pg" },
  mysql: { bg: "#e48e00", label: "My" },
  sqlite: { bg: "#0f80cc", label: "Lt" },
};

const describe = (c: ConnectionConfig) =>
  c.kind === "sqlite" ? c.file_path : `${c.user ? `${c.user}@` : ""}${c.host}:${c.port}${c.database ? `/${c.database}` : ""}`;

export function Welcome() {
  const s = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [menu, setMenu] = useState<{ c: ConnectionConfig; x: number; y: number } | null>(null);
  const listEl = useRef<HTMLDivElement>(null);
  const needle = q.trim().toLowerCase();
  const list = s.connections.filter((c) => !needle || [c.name, c.host, c.database, c.file_path, c.env].some((v) => v?.toLowerCase().includes(needle)));
  const open = async (id: string) => {
    if (busy) return;
    setBusy(id);
    await s.openConnection(id);
    setBusy(null);
  };
  const remove = async (c: ConnectionConfig) => {
    const ok = await ask("This removes the saved connection and its Keychain password. The database itself is not touched.",
      { title: `Delete the connection "${c.name}"?`, kind: "warning", okLabel: "Delete" });
    if (ok) await s.deleteConnection(c.id);
  };

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

  const empty = s.connections.length === 0;
  return (
    <div className="welcome">
      <div className="welcome-left" data-tauri-drag-region>
        <img className="welcome-icon" src={appIcon} alt="" draggable={false} />
        <h1>TableView</h1>
        <p>Fast tables. Claude built in.</p>
        <button className="btn primary" onClick={() => s.set({ editingConnection: "new" })} title="New connection (⌘N)"><Plus size={12} style={{ marginRight: 4, verticalAlign: -2 }} />New connection</button>
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          <button className="btn" onClick={() => s.set({ chatOpen: true })} title="Claude (⌘K)"><Sparkles size={12} style={{ marginRight: 4, verticalAlign: -2 }} />Claude</button>
          <button className="btn" onClick={() => s.set({ showSettings: true })} title="Settings (⌘,)"><Settings size={12} style={{ marginRight: 4, verticalAlign: -2 }} />Settings</button>
        </div>
        <button className="link-btn" onClick={() => s.set({ showShortcuts: true })}><Keyboard size={12} /> Keyboard shortcuts ⇧⌘/</button>
        <button className="link-btn" onClick={() => s.set({ showFeedback: true })}><MessageSquarePlus size={12} /> {s.updateReady ? "Update ready" : "Suggest a change ⇧⌘F"}</button>
      </div>
      <div className="welcome-right">
        {!empty && (
          <div style={{ padding: "4px 24px 8px" }}>
            <input autoCapitalize="off" autoCorrect="off" spellCheck={false} className="field" style={{ width: "100%", height: 30 }} placeholder="Search connections" value={q} onChange={(e) => setQ(e.target.value)} autoFocus
              aria-label="Search connections"
              onKeyDown={(e) => {
                if (e.key === "Escape" && q) setQ("");
                else if (e.key === "ArrowDown") { e.preventDefault(); listEl.current?.querySelector<HTMLElement>(".conn-item")?.focus(); }
                else if (e.key === "Enter" && !e.nativeEvent.isComposing && list[0]) open(list[0].id);
              }} />
          </div>
        )}
        <div className="conn-list" ref={listEl}>
          {list.map((c) => (
            <div key={c.id} className="conn-item" tabIndex={0} onDoubleClick={() => open(c.id)}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ c, x: e.clientX, y: e.clientY }); }}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                const items = [...(listEl.current?.querySelectorAll<HTMLElement>(".conn-item") ?? [])];
                const i = items.indexOf(e.currentTarget);
                if (e.key === "Enter") open(c.id);
                else if (e.key === "Backspace" && e.metaKey) { e.preventDefault(); remove(c); }
                else if (e.key === "ArrowDown") { e.preventDefault(); items[i + 1]?.focus(); }
                else if (e.key === "ArrowUp") { e.preventDefault(); if (i > 0) items[i - 1].focus(); else listEl.current?.parentElement?.querySelector<HTMLElement>("input")?.focus(); }
              }}>
              <div className="kind-icon" style={{ background: KIND_STYLE[c.kind].bg }}>{KIND_STYLE[c.kind].label}</div>
              <div className="meta">
                <div className="n">
                  <span className="conn-name" title={c.name}>{c.name}</span>
                  <span className="env-badge" style={{ background: ENV_COLORS[c.env] ?? ENV_COLORS.local }}>{c.env || "local"}</span>
                </div>
                <div className="d mono" title={describe(c)}>{describe(c)}</div>
              </div>
              {busy === c.id ? <div className="spinner" /> : <button className="btn" onClick={() => open(c.id)}>Connect</button>}
              <button className="icon-btn" title="Edit" aria-label={`Edit ${c.name}`} onClick={() => s.set({ editingConnection: c })}><Pencil size={13} /></button>
            </div>
          ))}
          {empty && (
            <div className="empty" style={{ height: "80%" }}>
              <Database size={28} />
              <div style={{ fontSize: 15, color: "var(--text)" }}>No connections yet</div>
              <div>Add a PostgreSQL, MySQL or SQLite database to get started.</div>
              <button className="btn primary" style={{ marginTop: 6 }} onClick={() => s.set({ editingConnection: "new" })}>New connection…</button>
            </div>
          )}
          {!empty && list.length === 0 && (
            <div className="empty" style={{ height: "60%" }}>No connections match "{q.trim()}"</div>
          )}
        </div>
      </div>
      {menu && (
        <div className="tv-menu" style={{ position: "fixed", left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
          <button onClick={() => { setMenu(null); open(menu.c.id); }}>Connect</button>
          <button onClick={() => { setMenu(null); s.set({ editingConnection: menu.c }); }}>Edit…</button>
          <hr />
          <button onClick={() => { setMenu(null); remove(menu.c); }}>Delete…</button>
        </div>
      )}
    </div>
  );
}
