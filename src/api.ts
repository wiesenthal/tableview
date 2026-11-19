import { invoke } from "@tauri-apps/api/core";
import { tableFromIPC, Table } from "apache-arrow";
import type { ImagePayload } from "./components/Attachments";
import type {
  BrowseOptions, Changes, ChatSettings, CommitOutcome, ConnectionConfig, McpInfo, QueryResult, SchemaTree,
  TableStructure,
} from "./types";

/** A saved query from TablePlus; `folder` is "/"-joined, empty at the top level. */
export type Favorite = { folder: string; name: string; sql: string };

export const api = {
  listConnections: () => invoke<ConnectionConfig[]>("list_connections"),
  saveConnection: (config: ConnectionConfig, password: string | null) =>
    invoke<ConnectionConfig>("save_connection", { config, password }),
  deleteConnection: (id: string) => invoke<void>("delete_connection", { id }),
  testConnection: (config: ConnectionConfig, password: string | null) =>
    invoke<string>("test_connection", { config, password }),
  connect: (id: string) => invoke<string>("connect", { id }),
  disconnect: (id: string) => invoke<void>("disconnect", { id }),
  getSchema: (id: string) => invoke<SchemaTree>("get_schema", { id }),
  describeTable: (id: string, schema: string, table: string) =>
    invoke<TableStructure>("describe_table", { id, schema, table }),
  browseTable: (id: string, schema: string, table: string, opts: BrowseOptions) =>
    invoke<QueryResult>("browse_table", { id, schema, table, opts }),
  countRows: (id: string, schema: string, table: string, opts: BrowseOptions) =>
    invoke<number>("count_rows", { id, schema, table, opts }),
  runQuery: (id: string, tabId: string, sql: string, queryId: string) =>
    invoke<QueryResult>("run_query", { id, tabId, sql, queryId }),
  cancelQuery: (queryId: string) => invoke<boolean>("cancel_query", { queryId }),
  closeTab: (id: string, tabId: string) => invoke<void>("close_tab", { id, tabId }),
  resultMeta: (resultId: string) => invoke<QueryResult>("get_result_meta", { resultId }),
  releaseResult: (resultId: string) => invoke<void>("release_result", { resultId }),
  commitChanges: (id: string, schema: string, table: string, resultId: string | null, changes: Changes, dryRun: boolean) =>
    invoke<CommitOutcome>("commit_changes", { id, schema, table, resultId, changes, dryRun }),
  mcpInfo: () => invoke<McpInfo>("mcp_info"),
  getChatSettings: () => invoke<ChatSettings>("get_chat_settings"),
  saveChatSettings: (chat: ChatSettings) => invoke<void>("save_chat_settings", { chat }),
  chatStart: (conversation: string, resume: string | null) => invoke<void>("chat_start", { conversation, resume }),
  chatSend: (conversation: string, text: string, images: ImagePayload[] = []) => invoke<void>("chat_send", { conversation, text, images }),
  chatInterrupt: (conversation: string) => invoke<void>("chat_interrupt", { conversation }),
  chatStop: (conversation: string) => invoke<void>("chat_stop", { conversation }),
  getPrefs: () => invoke<Record<string, unknown>>("get_prefs"),
  savePrefs: (prefs: Record<string, unknown>) => invoke<void>("save_prefs", { prefs }),
  listFavorites: () => invoke<Favorite[]>("list_favorites"),
  claudeAuthStatus: () => invoke<{ cli_found: boolean; logged_in: boolean; method: string }>("claude_auth_status"),
  claudeLogin: () => invoke<void>("claude_login"),
  claudeLoginCode: (code: string) => invoke<void>("claude_login_code", { code }),
  async resultTable(resultId: string): Promise<Table> {
    const buf = await invoke<ArrayBuffer>("get_result_arrow", { resultId });
    return tableFromIPC(new Uint8Array(buf));
  },
};

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return JSON.stringify(e);
}

type ConnTarget = Pick<ConnectionConfig, "kind" | "host" | "port" | "user" | "database" | "file_path">;

/**
 * Turns a driver error from connecting into a sentence a person can act on.
 * Unrecognised errors come back as the driver's text minus sqlx's prefixes.
 */
export function connectErrorText(raw: unknown, c?: ConnTarget): string {
  const text = errorText(raw);
  const where = c && c.kind !== "sqlite" ? `${c.host || "localhost"}:${c.port}` : "the server";
  const m = (re: RegExp) => text.match(re);
  let g: RegExpMatchArray | null;
  // Local databases usually run in a container, so a server that isn't answering often means the container app is off.
  const docker = c && c.kind !== "sqlite" && /^(localhost|127\.0\.0\.1|::1|host\.docker\.internal|.*\.orb\.local)?$/i.test(c.host)
    ? " If it runs in a container, make sure OrbStack or Docker is running."
    : "";
  if (m(/pool timed out|timed out|timeout/i))
    return `Could not connect to ${where} within 10 seconds. Check that the server is running and the host and port are right.${docker}`;
  if (m(/connection refused/i)) return `${where} refused the connection. Is the server running on that port?${docker}`;
  if (m(/failed to lookup address|nodename nor servname|name or service not known|no such host/i))
    return `Could not find the host "${c?.host ?? ""}". Check the spelling.`;
  if (m(/no route to host|network is unreachable|host is down/i)) return `Cannot reach ${where} from this Mac. Check the network or VPN.`;
  if ((g = m(/access denied for user .* to database '([^']+)'/i))) return `This user has no access to database "${g[1]}".`;
  if (m(/password authentication failed|access denied for user|authentication failed/i))
    return `The server rejected the user name or password${c?.user ? ` for "${c.user}"` : ""}.`;
  if ((g = m(/role "([^"]+)" does not exist/i))) return `User "${g[1]}" does not exist on this server.`;
  if ((g = m(/database "([^"]+)" does not exist|unknown database '([^']+)'/i)))
    return `Database "${g[1] ?? g[2]}" does not exist on this server.`;
  if (m(/no pg_hba\.conf entry/i))
    return `The server's pg_hba.conf does not allow this user, database or address${/no encryption/i.test(text) ? " without SSL. Try SSL \"require\"." : "."}`;
  if (m(/server does not support (tls|ssl)/i)) return `The server does not support SSL. Set SSL to "prefer" or "disable".`;
  if (m(/\b(tls|ssl)\b|certificate/i)) return `Could not set up an SSL connection: ${clean(text)}`;
  if ((g = m(/SQLite file not found: (.*)$/))) return `No SQLite file at ${g[1]}.`;
  if (m(/unable to open database file|file is not a database/i)) return `That file could not be opened as a SQLite database.`;
  return clean(text);
}

function clean(text: string): string {
  return text
    .replace(/^error (returned from|communicating with) database: /, "")
    .replace(/^error occurred while attempting to establish a TLS connection: /, "")
    .replace(/^\d+ \([0-9A-Z]{5}\): /, "")
    .replace(/ at line \d+$/, "");
}
