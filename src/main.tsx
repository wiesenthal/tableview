import { Component, ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { Menu, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import App from "./App";
import { useStore } from "./store";

/** Shows a crash with a way back instead of a blank window. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash">
        <h2>TableView hit an error</h2>
        <pre>{String(this.state.error.stack ?? this.state.error)}</pre>
        <button className="btn primary" onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  }
}

window.addEventListener("keydown", (e) => {
  if (e.metaKey && e.shiftKey && e.key.toLowerCase() === "r") window.location.reload();
});

/**
 * The macOS menu bar. Shortcuts are handled by the window's key handler first
 * (App.tsx), which consumes them, so a menu accelerator only fires from a mouse
 * click or when the page did not act on the key. Each action therefore applies
 * the same guards as its key handler. If building the menu fails, Tauri's
 * default menu stays.
 */
async function installMenu() {
  const st = () => useStore.getState();
  const sep = { item: "Separator" } as const;
  const app = await Submenu.new({
    text: "TableView",
    items: [
      await PredefinedMenuItem.new({ item: { About: null }, text: "About TableView" }),
      sep,
      { text: "Settings…", accelerator: "CmdOrCtrl+,", action: () => st().set({ showSettings: true }) },
      sep,
      { item: "Services" },
      sep,
      { item: "Hide" },
      { item: "HideOthers" },
      { item: "ShowAll" },
      sep,
      { item: "Quit" },
    ],
  });
  const file = await Submenu.new({
    text: "File",
    items: [
      { text: "New Connection…", accelerator: "CmdOrCtrl+N", action: () => st().set({ editingConnection: "new" }) },
      { text: "New Query", accelerator: "CmdOrCtrl+T", action: () => { if (st().activeConnectionId) st().openQuery(); } },
      { text: "Open Table…", accelerator: "CmdOrCtrl+P", action: () => { if (st().activeConnectionId) st().set({ quickOpen: true }); } },
      { text: "Reopen Closed Tab", accelerator: "CmdOrCtrl+Shift+T", action: () => { if (st().activeConnectionId) st().reopenTab(); } },
      sep,
      { text: "Refresh Schema", action: () => st().refreshSchema() },
      { text: "Switch Connection", action: () => st().closeConnection() },
    ],
  });
  const edit = await Submenu.new({
    text: "Edit",
    items: [{ item: "Undo" }, { item: "Redo" }, sep, { item: "Cut" }, { item: "Copy" }, { item: "Paste" }, { item: "SelectAll" }],
  });
  const view = await Submenu.new({
    text: "View",
    items: [
      { text: "Claude Panel", accelerator: "CmdOrCtrl+K", action: () => st().set({ chatOpen: !st().chatOpen }) },
      sep,
      { item: "Fullscreen" },
    ],
  });
  const win = await Submenu.new({
    text: "Window",
    items: [{ item: "Minimize" }, { item: "Maximize" }, sep, { item: "CloseWindow" }],
  });
  const help = await Submenu.new({
    text: "Help",
    items: [{ text: "Keyboard Shortcuts", accelerator: "CmdOrCtrl+Shift+/", action: () => st().set({ showShortcuts: true }) }],
  });
  const menu = await Menu.new({ items: [app, file, edit, view, win, help] });
  await menu.setAsAppMenu();
  await win.setAsWindowsMenuForNSApp().catch(() => {});
  await help.setAsHelpMenuForNSApp().catch(() => {});
}

if ("__TAURI_INTERNALS__" in window) installMenu().catch((e) => console.warn("menu not installed", e));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
