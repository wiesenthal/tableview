import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { ask, open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, connectErrorText, errorText } from "../api";
import { useStore } from "../store";
import type { ConnectionConfig, McpInfo, TableStructure } from "../types";
import { PREF_DEFS, Prefs } from "../prefs";
import "../nav.css";

function Modal({ title, children, onClose, onSubmit, width = 480 }: { title: string; children: React.ReactNode; onClose: () => void; onSubmit?: () => void; width?: number }) {
  const submit = useRef(onSubmit);
  submit.current = onSubmit;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => { if (prev?.isConnected) prev.focus(); };
  }, []);
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      const t = e.target as HTMLElement;
      if (e.key === "Enter" && submit.current && !e.isComposing && !e.shiftKey && t.tagName === "INPUT" && (t as HTMLInputElement).type !== "checkbox") {
        e.preventDefault();
        submit.current();
      }
    };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width }}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

export function CommitDialog({ statements, onCancel, onCommit }: { statements: string[]; onCancel: () => void; onCommit: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={`Commit ${statements.length} statement${statements.length === 1 ? "" : "s"}`} onClose={onCancel} width={640}>
      <div className="code-block" style={{ maxHeight: 320, overflow: "auto", whiteSpace: "pre-wrap" }}>
        {statements.map((s) => s + ";").join("\n\n")}
      </div>
      <div className="modal-actions">
        <span className="msg">Runs in one transaction. If any row changed since it loaded, nothing is saved.</span>
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn primary" autoFocus disabled={busy} onClick={() => { setBusy(true); onCommit(); }}>Commit</button>
      </div>
    </Modal>
  );
}

export function InsertDialog({ structure, onCancel, onAdd }: { structure: TableStructure; onCancel: () => void; onAdd: (row: Record<string, string | null>) => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [nulls, setNulls] = useState<Set<string>>(new Set());
  const add = () => {
    const row: Record<string, string | null> = {};
    for (const c of structure.columns) {
      if (nulls.has(c.name)) row[c.name] = null;
      else if (values[c.name] !== undefined && values[c.name] !== "") row[c.name] = values[c.name];
    }
    onAdd(row);
  };
  return (
    <Modal title="Insert row" onClose={onCancel} onSubmit={add} width={560}>
      <div className="form" style={{ maxHeight: 420, overflow: "auto", gridTemplateColumns: "150px 1fr auto" }}>
        {structure.columns.map((c) => (
          <div key={c.name} style={{ display: "contents" }}>
            <label className="mono" title={c.data_type}>{c.name}</label>
            <input autoCapitalize="off" autoCorrect="off" spellCheck={false} className="field mono" autoFocus={c === structure.columns[0]} placeholder={c.default ? `DEFAULT ${c.default}` : c.nullable ? "NULL" : c.data_type}
              disabled={nulls.has(c.name)} value={values[c.name] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [c.name]: e.target.value }))} />
            <label style={{ display: "flex", gap: 4, alignItems: "center", textAlign: "left" }}>
              <input autoCapitalize="off" autoCorrect="off" spellCheck={false} type="checkbox" checked={nulls.has(c.name)} onChange={() => setNulls((s) => {
                const n = new Set(s);
                if (n.has(c.name)) n.delete(c.name); else n.add(c.name);
                return n;
              })} />NULL
            </label>
          </div>
        ))}
      </div>
      <div className="modal-actions">
        <span className="msg">Empty fields use the column default.</span>
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn primary" onClick={add}>Add to pending changes</button>
      </div>
    </Modal>
  );
}

const DEFAULT_PORTS: Record<ConnectionConfig["kind"], number> = { postgres: 5432, mysql: 3306, sqlite: 0 };
const DEFAULT_USERS: Record<ConnectionConfig["kind"], string> = { postgres: "postgres", mysql: "root", sqlite: "" };
const KIND_LABEL: Record<ConnectionConfig["kind"], string> = { postgres: "PostgreSQL", mysql: "MySQL", sqlite: "SQLite" };

/** A name for a connection saved without one, the way TablePlus fills it in. */
function defaultName(c: ConnectionConfig): string {
  if (c.kind === "sqlite") return c.file_path.split("/").pop() || "SQLite";
  return c.database || c.host || KIND_LABEL[c.kind];
}

/** Returns what is missing or wrong, or null when the form can be saved. */
function validate(c: ConnectionConfig): string | null {
  if (c.kind === "sqlite") return c.file_path.trim() ? null : "Choose a SQLite file.";
  if (!c.host.trim()) return "Enter a host, for example 127.0.0.1.";
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) return "Enter a port between 1 and 65535.";
  return null;
}

export function ConnectionDialog({ initial }: { initial: ConnectionConfig | "new" }) {
  const { set, loadConnections, openConnection, deleteConnection } = useStore();
  const isNew = initial === "new";
  const [c, setC] = useState<ConnectionConfig>(
    isNew
      ? { id: "", name: "", kind: "postgres", host: "127.0.0.1", port: 5432, user: "postgres", database: "", file_path: "", ssl_mode: "prefer", env: "local", read_only: false, allow_claude: true }
      : initial,
  );
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string; detail?: string } | null>(null);
  const [busy, setBusy] = useState<"test" | "save" | "connect" | null>(null);
  const up = (p: Partial<ConnectionConfig>) => { setC((x) => ({ ...x, ...p })); setMsg(null); };
  const close = () => set({ editingConnection: null });

  const setKind = (kind: ConnectionConfig["kind"]) => {
    if (kind === c.kind) return;
    // Keep a port or user the person typed; swap only the previous engine's defaults.
    up({
      kind,
      port: !c.port || c.port === DEFAULT_PORTS[c.kind] ? DEFAULT_PORTS[kind] : c.port,
      user: !c.user || c.user === DEFAULT_USERS[c.kind] ? DEFAULT_USERS[kind] : c.user,
    });
  };

  const test = async () => {
    if (busy) return;
    const invalid = validate(c);
    if (invalid) return setMsg({ ok: false, text: invalid });
    setBusy("test");
    setMsg(null);
    try {
      setMsg({ ok: true, text: `Connected to ${await api.testConnection(c, password || null)}.` });
    } catch (e) {
      setMsg({ ok: false, text: connectErrorText(e, c), detail: errorText(e) });
    }
    setBusy(null);
  };

  /** Saves, and with `connect` stays open until connected so a failure shows here, not in a toast. */
  const save = async (connect: boolean) => {
    if (busy) return;
    const invalid = validate(c);
    if (invalid) return setMsg({ ok: false, text: invalid });
    setBusy(connect ? "connect" : "save");
    setMsg(null);
    let saved: ConnectionConfig;
    try {
      saved = await api.saveConnection({ ...c, name: c.name.trim() || defaultName(c) }, password || null);
      await loadConnections();
    } catch (e) {
      setMsg({ ok: false, text: `Could not save: ${errorText(e)}` });
      setBusy(null);
      return;
    }
    // From here on edits update this saved row instead of adding another.
    setC(saved);
    setPassword("");
    if (!connect) return close();
    try {
      await api.connect(saved.id);
    } catch (e) {
      setMsg({ ok: false, text: connectErrorText(e, saved), detail: errorText(e) });
      setBusy(null);
      return;
    }
    close();
    await openConnection(saved.id);
  };

  const remove = async () => {
    const ok = await ask("This removes the saved connection and its Keychain password. The database itself is not touched.",
      { title: `Delete the connection "${c.name}"?`, kind: "warning", okLabel: "Delete" });
    if (ok && await deleteConnection(c.id)) close();
  };

  const text = { autoCapitalize: "off", autoCorrect: "off", spellCheck: false } as const;
  return (
    <Modal title={isNew && !c.id ? "New connection" : `Edit ${c.name}`} onClose={close} onSubmit={() => save(true)} width={500}>
      <div className="form">
        <label>Type</label>
        <div className="segmented" style={{ justifySelf: "start" }}>
          {(["postgres", "mysql", "sqlite"] as const).map((k) => (
            <button key={k} className={c.kind === k ? "on" : ""} onClick={() => setKind(k)}>{KIND_LABEL[k]}</button>
          ))}
        </div>
        <label htmlFor="conn-name">Name</label>
        <input id="conn-name" {...text} className="field" autoFocus value={c.name} onChange={(e) => up({ name: e.target.value })} placeholder={defaultName(c)} />
        <label>Environment</label>
        <div className="segmented" style={{ justifySelf: "start" }} title="prod connections default to read-only with Claude off">
          {["local", "dev", "staging", "prod"].map((env) => (
            <button key={env} className={c.env === env ? "on" : ""} onClick={() => up({ env, allow_claude: env === "prod" ? false : c.allow_claude, read_only: env === "prod" ? true : c.read_only })}>{env}</button>
          ))}
        </div>
        {c.kind === "sqlite" ? (
          <>
            <label htmlFor="conn-file">File</label>
            <div style={{ display: "flex", gap: 6, minWidth: 0 }}>
              <input id="conn-file" {...text} className="field mono" style={{ flex: 1 }} value={c.file_path} onChange={(e) => up({ file_path: e.target.value })} placeholder="~/data/app.db" />
              <button className="btn" onClick={async () => {
                const f = await openDialog({ multiple: false, directory: false, title: "Choose a SQLite database" });
                if (typeof f === "string") up({ file_path: f });
              }}>Choose…</button>
            </div>
          </>
        ) : (
          <>
            <label htmlFor="conn-host">Host</label>
            <div style={{ display: "flex", gap: 6, alignItems: "center", minWidth: 0 }}>
              <input id="conn-host" {...text} className="field mono" style={{ flex: 1 }} value={c.host} placeholder="127.0.0.1" onChange={(e) => up({ host: e.target.value.trim() })} />
              <label htmlFor="conn-port">Port</label>
              <input id="conn-port" {...text} className="field mono" style={{ width: 70 }} inputMode="numeric" maxLength={5} value={c.port || ""} placeholder={String(DEFAULT_PORTS[c.kind])}
                onChange={(e) => up({ port: Number(e.target.value.replace(/\D/g, "")) || 0 })} />
            </div>
            <label htmlFor="conn-user">User</label>
            <input id="conn-user" {...text} className="field mono" value={c.user} placeholder={DEFAULT_USERS[c.kind]} onChange={(e) => up({ user: e.target.value })} />
            <label htmlFor="conn-pass">Password</label>
            <input id="conn-pass" {...text} className="field mono" type="password" value={password} onChange={(e) => { setPassword(e.target.value); setMsg(null); }}
              placeholder={c.id ? "unchanged (stored in the Keychain)" : "stored in the macOS Keychain"} />
            <label htmlFor="conn-db">Database</label>
            <input id="conn-db" {...text} className="field mono" value={c.database} onChange={(e) => up({ database: e.target.value })}
              placeholder={c.kind === "postgres" ? "defaults to the user name" : "optional"} />
            <label htmlFor="conn-ssl">SSL</label>
            <select id="conn-ssl" className="field" style={{ justifySelf: "start" }} value={c.ssl_mode || "prefer"} onChange={(e) => up({ ssl_mode: e.target.value })}>
              <option value="disable">disable</option><option value="prefer">prefer</option><option value="require">require</option>
            </select>
          </>
        )}
        <label />
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label className="check">
            <input type="checkbox" checked={c.read_only} onChange={(e) => up({ read_only: e.target.checked })} /> Read-only (no edits or writes)
          </label>
          <label className="check">
            <input type="checkbox" checked={c.allow_claude} onChange={(e) => up({ allow_claude: e.target.checked })} /> Let Claude run read-only queries
          </label>
        </div>
      </div>
      {msg && <div className={`form-msg ${msg.ok ? "ok" : "err"}`} title={msg.detail !== msg.text ? msg.detail : undefined} role="status">{msg.text}</div>}
      <div className="modal-actions">
        {c.id && <button className="btn danger" disabled={!!busy} onClick={remove}>Delete</button>}
        <span className="msg" />
        <button className="btn" disabled={!!busy} onClick={test}>{busy === "test" ? "Testing…" : "Test"}</button>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn" disabled={!!busy} onClick={() => save(false)}>Save</button>
        <button className="btn primary" disabled={!!busy} onClick={() => save(true)}>{busy === "connect" ? "Connecting…" : "Connect"}</button>
      </div>
    </Modal>
  );
}

const SHORTCUTS: { group: string; items: [string, string][] }[] = [
  { group: "General", items: [
    ["⌘N", "New connection"], ["⌘,", "Settings"], ["⌘K", "Show or hide the Claude panel"], ["⇧⌘/", "Keyboard shortcuts"], ["⇧⌘R", "Reload the window"],
  ] },
  { group: "Tabs", items: [
    ["⌘P", "Open a table"], ["⌘T", "New SQL query"], ["⌘W", "Close tab"], ["⇧⌘T", "Reopen closed tab"],
    ["⌘1 – ⌘9", "Go to tab"], ["⇧⌘[  ⇧⌘]", "Previous / next tab"], ["⌃Tab  ⌃⇧Tab", "Next / previous tab"],
  ] },
  { group: "Table", items: [
    ["⌘F", "Filter rows"], ["⌘R", "Refresh"], ["⌘S", "Review and commit changes"], ["Double-click", "Edit a cell"], ["Delete", "Set cells to NULL, or mark selected rows for deletion"],
  ] },
  { group: "SQL query", items: [
    ["⌘↵", "Run the statement under the cursor, or the selection"], ["⇧⌘↵", "Run all statements"],
  ] },
];

export function ShortcutsDialog() {
  const set = useStore((s) => s.set);
  const close = () => set({ showShortcuts: false });
  return (
    <Modal title="Keyboard shortcuts" onClose={close} width={460}>
      <div className="shortcuts">
        {SHORTCUTS.map((g) => (
          <div key={g.group}>
            <div className="shortcuts-group">{g.group}</div>
            {g.items.map(([k, d]) => (
              <div key={k} className="shortcut"><span>{d}</span><kbd>{k}</kbd></div>
            ))}
          </div>
        ))}
      </div>
      <div className="modal-actions">
        <span className="msg" />
        <button className="btn primary" autoFocus onClick={close}>Done</button>
      </div>
    </Modal>
  );
}

/** Renders every registered preference; changes apply and save immediately. */
function PrefsSection() {
  const { prefs, setPref } = useStore();
  const sections = [...new Set(PREF_DEFS.map((d) => d.section))];
  return (
    <>
      {sections.map((section) => (
        <div key={section}>
          <div className="section-title" style={{ paddingLeft: 16 }}>{section}</div>
          <div className="prefs">
            {PREF_DEFS.filter((d) => d.section === section).map((d) => (
              <div key={d.key} className="pref">
                <div className="pref-text">
                  <div className="pref-label">{d.label}</div>
                  <div className="pref-desc">{d.description}</div>
                </div>
                {d.kind === "toggle" ? (
                  <input type="checkbox" className="switch" checked={prefs[d.key as keyof Prefs] as boolean}
                    onChange={(e) => setPref(d.key as keyof Prefs, e.target.checked as never)} />
                ) : (
                  <select className="field" value={prefs[d.key as keyof Prefs] as string}
                    onChange={(e) => setPref(d.key as keyof Prefs, e.target.value as never)}>
                    {d.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

export function SettingsDialog() {
  const { set, chatSettings, saveChatSettings, notify } = useStore();
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [chat, setChat] = useState(chatSettings);
  const [upd, setUpd] = useState<{ source_dir: string; signing_identity: string; auto_merge: boolean; default_source_dir: string } | null>(null);
  const [updSaved, setUpdSaved] = useState("");
  useEffect(() => {
    api.mcpInfo().then(setInfo).catch((e) => notify(errorText(e), true));
    invoke<{ source_dir: string; signing_identity: string; auto_merge: boolean; default_source_dir: string }>("get_update_settings")
      .then((u) => { setUpd(u); setUpdSaved(JSON.stringify(u)); })
      .catch(() => {});
  }, [notify]);
  // Like macOS settings windows, changes apply on close; there is no Cancel.
  const close = async () => {
    if (JSON.stringify(chat) !== JSON.stringify(chatSettings)) await saveChatSettings(chat);
    if (upd && JSON.stringify(upd) !== updSaved) {
      await invoke("save_update_settings", { sourceDir: upd.source_dir, signingIdentity: upd.signing_identity, autoMerge: upd.auto_merge }).catch((e) => notify(errorText(e), true));
    }
    set({ showSettings: false });
  };
  return (
    <Modal title="Settings" onClose={close} onSubmit={close} width={620}>
      <div style={{ maxHeight: "70vh", overflow: "auto" }}>
      <PrefsSection />
      <div className="section-title" style={{ paddingLeft: 16 }}>Claude chat (⌘K)</div>
      <div className="form" style={{ gridTemplateColumns: "140px 1fr" }}>
        <label>Panel side</label>
        <div className="segmented" style={{ justifySelf: "start" }}>
          {(["left", "right"] as const).map((s) => <button key={s} className={chat.side === s ? "on" : ""} onClick={() => setChat({ ...chat, side: s })}>{s}</button>)}
        </div>
        <label>Model</label>
        <input autoCapitalize="off" autoCorrect="off" spellCheck={false} className="field mono" value={chat.model} placeholder="default (your Claude Code setting)" onChange={(e) => setChat({ ...chat, model: e.target.value })} />
        <label>Instructions</label>
        <textarea autoCapitalize="off" autoCorrect="off" spellCheck={false} className="field" style={{ height: 70, padding: 6, resize: "vertical" }} value={chat.extra_instructions}
          placeholder="e.g. Prefer CTEs. Revenue is in cents. Always chart time series." onChange={(e) => setChat({ ...chat, extra_instructions: e.target.value })} />
        <label>claude CLI</label>
        <input autoCapitalize="off" autoCorrect="off" spellCheck={false} className="field mono" value={chat.claude_path} placeholder={info?.claude_found ?? "not found; set the path"} onChange={(e) => setChat({ ...chat, claude_path: e.target.value })} />
      </div>
      <div className="section-title" style={{ paddingLeft: 16 }}>Feedback and updates (⇧⌘F)</div>
      {upd && (
        <div className="form" style={{ gridTemplateColumns: "140px 1fr" }}>
          <label>Merge automatically</label>
          <label style={{ textAlign: "left", display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" className="switch" checked={upd.auto_merge} onChange={(e) => setUpd({ ...upd, auto_merge: e.target.checked })} />
            <span style={{ color: "var(--text-2)" }}>When the type-check, build and tests pass, merge and update without waiting for review</span>
          </label>
          <label>Source folder</label>
          <input autoCapitalize="off" autoCorrect="off" spellCheck={false} className="field mono" value={upd.source_dir}
            placeholder={upd.default_source_dir} onChange={(e) => setUpd({ ...upd, source_dir: e.target.value })} />
          <label>Signing identity</label>
          <input autoCapitalize="off" autoCorrect="off" spellCheck={false} className="field mono" value={upd.signing_identity}
            placeholder="optional: keeps Keychain access across updates" onChange={(e) => setUpd({ ...upd, signing_identity: e.target.value })} />
        </div>
      )}
      <div className="section-title" style={{ paddingLeft: 16 }}>Use TableView from Claude Code in your terminal</div>
      <div style={{ padding: "0 16px 6px", fontSize: 12, color: "var(--text-2)" }}>
        MCP server {info?.status ?? "…"}. Run this once to add it to Claude Code:
      </div>
      <div className="code-block" style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <span style={{ flex: 1, minWidth: 0 }}>{info?.claude_command ?? "…"}</span>
        <button className="btn" disabled={!info?.claude_command} onClick={() => {
          navigator.clipboard.writeText(info?.claude_command ?? "").then(() => notify("Copied"), (e) => notify(errorText(e), true));
        }}>Copy</button>
      </div>
      </div>
      <div className="modal-actions">
        <span className="msg" />
        <button className="btn primary" onClick={close}>Done</button>
      </div>
    </Modal>
  );
}
