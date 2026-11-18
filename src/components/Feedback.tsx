import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CheckCircle2, Image as ImageIcon, ChevronRight, GitPullRequest, Loader2, RefreshCw, RotateCw, Trash2, XCircle } from "lucide-react";
import { errorText } from "../api";
import { useStore } from "../store";
import "../feedback.css";
import { AttachmentStrip, useAttachments } from "./Attachments";

type Status = "working" | "pr_open" | "merged" | "ready" | "installed" | "closed" | "failed";

interface Item {
  id: string;
  text: string;
  created_at: string;
  status: Status;
  branch: string;
  pr_url: string | null;
  summary: string | null;
  error: string | null;
  log: string[];
  images?: number;
}

interface Readiness {
  source_dir: string;
  problems: string[];
}

const STATUS: Record<Status, { label: string; tone: string }> = {
  working: { label: "Claude is working", tone: "busy" },
  pr_open: { label: "PR open, waiting for merge", tone: "open" },
  merged: { label: "Merged, building update", tone: "busy" },
  ready: { label: "Update ready", tone: "done" },
  installed: { label: "Installed", tone: "muted" },
  closed: { label: "PR closed", tone: "muted" },
  failed: { label: "Failed", tone: "bad" },
};

function ItemRow({ item, onRemove, onRetry }: { item: Item; onRemove: () => void; onRetry: () => void }) {
  const [open, setOpen] = useState(item.status === "working" || item.status === "failed");
  const st = item.status === "merged" && item.error ? { label: "Merged, update failed", tone: "bad" } : STATUS[item.status];
  return (
    <div className={`fb-item ${st.tone}`}>
      <div className="fb-head" onClick={() => setOpen(!open)}>
        <ChevronRight size={13} className="fb-chevron" style={{ transform: open ? "rotate(90deg)" : "none" }} />
        <div className="fb-text">{item.text}</div>
        {!!item.images && <span className="fb-pics" title={`${item.images} image${item.images > 1 ? "s" : ""} attached`}><ImageIcon size={11} />{item.images}</span>}
        <span className={`fb-status ${st.tone}`}>
          {st.tone === "busy" ? <Loader2 size={11} className="fb-spin" /> : st.tone === "done" ? <CheckCircle2 size={11} /> : st.tone === "bad" ? <XCircle size={11} /> : <GitPullRequest size={11} />}
          {st.label}
        </span>
      </div>
      {open && (
        <div className="fb-body">
          {item.error && <div className="error-box" style={{ margin: "0 0 8px" }}>{item.error}</div>}
          {item.summary && <div className="fb-summary">{item.summary}</div>}
          {item.log.length > 0 && <pre className="fb-log">{item.log.join("\n")}</pre>}
          <div className="fb-actions">
            {item.pr_url && <button className="btn" onClick={() => openUrl(item.pr_url!).catch(() => {})}><GitPullRequest size={11} style={{ marginRight: 4, verticalAlign: -1 }} />Open pull request</button>}
            {item.status === "merged" && item.error && <button className="btn" onClick={() => invoke("feedback_rebuild").catch(() => {})}><RefreshCw size={11} style={{ marginRight: 4, verticalAlign: -1 }} />Build again</button>}
            {item.status === "pr_open" && item.error && <button className="btn" onClick={onRetry}><RefreshCw size={11} style={{ marginRight: 4, verticalAlign: -1 }} />Try merging again</button>}
            <span className="fb-branch mono">{item.branch}</span>
            <div style={{ flex: 1 }} />
            {item.status !== "working" && item.status !== "merged" && (
              <button className="icon-btn" title="Remove from this list" onClick={onRemove}><Trash2 size={13} /></button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Feedback becomes a pull request; a merged one rebuilds and updates TableView. */
export function FeedbackDialog() {
  const { set, notify } = useStore();
  const [items, setItems] = useState<Item[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState<Readiness | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const close = useCallback(() => set({ showFeedback: false }), [set]);
  const attachError = useCallback((m: string) => notify(m, true), [notify]);
  const attach = useAttachments(attachError);

  const refresh = useCallback(() => invoke<Item[]>("feedback_list").then(setItems).catch(() => {}), []);

  useEffect(() => {
    refresh();
    invoke<Readiness>("feedback_readiness").then(setReady).catch(() => {});
    const subs = [
      listen<Item>("feedback-updated", ({ payload }) => setItems((list) => {
        const i = list.findIndex((x) => x.id === payload.id);
        if (i < 0) return [payload, ...list];
        const next = [...list];
        next[i] = payload;
        return next;
      })),
      listen<{ line: string }>("update-progress", ({ payload }) => { setProgress(payload.line); setUpdateError(null); }),
      listen("update-ready", () => { setProgress(null); refresh(); }),
      listen<{ error: string }>("update-failed", ({ payload }) => { setProgress(null); setUpdateError(payload.error); }),
    ];
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => {
      subs.forEach((p) => p.then((f) => f()));
      window.removeEventListener("keydown", onKey);
    };
  }, [refresh, close]);

  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const item = await invoke<Item>("feedback_submit", { text, images: attach.payload() });
      setItems((list) => [item, ...list.filter((x) => x.id !== item.id)]);
      setText("");
      attach.clear();
    } catch (e) {
      notify(errorText(e), true);
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    setChecking(true);
    try {
      const merged = await invoke<number>("feedback_check");
      notify(merged ? `${merged} merged; building the update` : "No newly merged pull requests");
    } catch (e) {
      notify(errorText(e), true);
    } finally {
      setChecking(false);
    }
  };

  const hasReady = items.some((i) => i.status === "ready");
  const blocked = ready?.problems.length ? ready.problems : null;

  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal fb-modal">
        <h3>Feedback</h3>
        <p className="fb-intro">
          Describe a change to TableView. Claude Code makes it in its own branch and opens a pull request. TableView then runs the type-check,
          build and tests itself; if they pass it merges the PR, rebuilds and asks to restart. If a check fails, the PR stays open for you.
          (Turn off automatic merging in Settings to review every change first.)
        </p>
        {blocked && <div className="error-box" style={{ margin: "0 16px 10px" }}>{blocked.join("\n")}</div>}
        <div className={`fb-compose${attach.dragging ? " dropping" : ""}`} {...attach.zoneProps}>
          <div className="fb-compose-box">
          <textarea autoCapitalize="off" autoCorrect="off" spellCheck rows={3} value={text} disabled={!!blocked}
            placeholder="e.g. Show row counts next to each table in the sidebar"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } }} />
          <AttachmentStrip images={attach.images} onRemove={attach.remove} />
          </div>
          {!blocked && attach.picker}
          <button className="btn primary" disabled={!text.trim() || busy || !!blocked} onClick={submit}>{busy ? "Starting…" : "Send ⌘↵"}</button>
        </div>
        {(hasReady || progress || updateError) && (
          <div className={`fb-update ${updateError ? "bad" : hasReady ? "done" : "busy"}`}>
            {updateError ? <XCircle size={14} /> : hasReady ? <CheckCircle2 size={14} /> : <Loader2 size={14} className="fb-spin" />}
            <span className="fb-update-text">{updateError ?? (hasReady && !progress ? "A new version is built and ready." : progress)}</span>
            {hasReady && !progress && (
              <button className="btn primary" onClick={() => invoke("update_restart").catch((e) => notify(errorText(e), true))}>
                <RotateCw size={11} style={{ marginRight: 4, verticalAlign: -1 }} />Restart to update
              </button>
            )}
            {updateError && <button className="btn" onClick={() => invoke("feedback_rebuild").catch(() => {})}>Try again</button>}
          </div>
        )}
        <div className="fb-list">
          {items.length === 0 && <div className="fb-empty">No feedback yet.</div>}
          {items.map((item) => (
            <ItemRow key={item.id} item={item}
              onRetry={() => invoke<number>("feedback_retry", { id: item.id }).then(refresh).catch((e) => notify(errorText(e), true))}
              onRemove={() => { invoke("feedback_remove", { id: item.id }); setItems((l) => l.filter((x) => x.id !== item.id)); }} />
          ))}
        </div>
        <div className="modal-actions">
          <span className="msg mono" title="Source checkout used for changes and rebuilds">{ready?.source_dir}</span>
          <button className="btn" disabled={checking} onClick={check}><RefreshCw size={11} style={{ marginRight: 4, verticalAlign: -1 }} />Check for merges</button>
          <button className="btn primary" onClick={close}>Done</button>
        </div>
      </div>
    </div>
  );
}
