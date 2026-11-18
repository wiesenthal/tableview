# TableView architecture

TableView is a macOS database client in the style of TablePlus. It stays fast with large result sets, and Claude can query and chart data in the app window, either from the built-in chat panel or from Claude Code in a terminal over MCP.

## Layout

```
src/                     React 19 + TypeScript frontend (WKWebView)
  App.tsx                tabs, global shortcuts, Claude event listeners
  main.tsx               error boundary, macOS menu bar
  store.ts               zustand store: connections, tabs, pinned tabs, toasts
  api.ts                 typed wrappers over Tauri commands, error text
  prefs.ts               display preferences (the frontend owns keys and defaults)
  components/            Welcome, Sidebar, TableView, QueryView, DataGrid,
                         ChartView, ChatPanel, QuickOpen, Dialogs
src-tauri/src/
  lib.rs                 Tauri commands and app setup
  state.rs               AppState: pools, per-tab sessions, result store
  config.rs              connections.json, settings.json, Keychain
  db/mod.rs              connect, introspection, browse and query execution
  db/decode.rs           per-driver row decoding into cells
  db/columns.rs          cells to Arrow record batches, with row and byte caps
  db/guard.rs            read-only SQL gate for Claude
  edits.rs               grid edits to parameterized SQL
  results.rs             ResultStore (Arrow IPC bytes, evicted by size)
  mcp.rs                 MCP server for Claude
  chat.rs                the in-app Claude panel (runs the `claude` CLI)
  itest.rs               integration tests against the tests/seed containers
tests/seed/              pg.sql and mysql.sql seed data
```

## Stack

- Tauri 2 shell. Rust backend, React 19 + TypeScript frontend in WKWebView, built with Vite.
- Drivers are sqlx 0.9 pools for Postgres, MySQL and SQLite (rustls for TLS).
- Results cross the Rust/JS boundary as Arrow IPC bytes through a raw `tauri::ipc::Response` and are read with `apache-arrow`. A prototype measured 1M rows (73 MB) in 23 ms.
- The grid is Glide Data Grid 6 (canvas). The SQL editor is CodeMirror 6. Charts are ECharts 6.
- The MCP server is rmcp streamable HTTP on 127.0.0.1, embedded in the app process.

## Storage

App files live in `~/Library/Application Support/com.zwies.tableview/`, or in `$TABLEVIEW_DATA_DIR` when it is set (which also lets a second instance run beside the first).

- `connections.json`: saved connections, written with mode 0600.
- `settings.json`: MCP port (default 47821) and bearer token, chat panel settings, display preferences.
- Passwords live in the macOS Keychain (service `TableView`, account = connection id), never in JSON.
- Pinned tabs are kept per connection in the webview's localStorage (`tv.pinned.<id>`).
- The last open connection and its tabs are kept in localStorage (`tv.session`) and reopened at launch; going back to the connection list clears it.

## Data shapes

```
ConnectionConfig { id, name, kind: postgres|mysql|sqlite, host, port: u16, user, database,
                   file_path, ssl_mode: disable|prefer|require, env: local|dev|staging|prod,
                   read_only, allow_claude }

Pool           Pg | My | Lite { rw, ro }          one per connection id
Session        one pinned connection per SQL tab, so SET, transactions and search_path
               persist within a tab; it is closed, not returned to the pool, with the tab

SchemaTree     { schemas: [{ name, tables: [{ schema, name, kind: table|view }] }] }
TableStructure { columns: [{ name, data_type, nullable, default, is_pk, is_fk }],
                 indexes: [{ name, columns, unique }] }

QueryResult    { id, connection_id, sql, columns: [{ name, db_type }], row_count,
                 elapsed_ms, truncated, rows_affected? }
  The Arrow bytes stay in the ResultStore (1.5 GB cap; over it, Claude's results
  go first, then the oldest). The UI
  fetches them with get_result_arrow(id) and releases them when the tab closes.

Changes        { edits: [{ row, column, value }], deletes: [row], inserts: [{ col: value }] }
  commit_changes turns them into parameterized statements in one transaction (edits.rs).
  Rows are found by primary key, and each UPDATE also checks the edited column still holds
  the value the grid showed, so a concurrent change aborts the commit. dry_run returns the
  SQL for the review sheet. Tables without a primary key are read-only.

VizSpec        { kind: bar|line|area|scatter|pie, x, y: [col], series_by?, title? }
```

## Type mapping to Arrow

Rows decode through sqlx's typed decoders, so both binary (prepared) and text (`raw_sql`) formats work. Integers become Int64, floats Float64, bool Boolean, timestamps Timestamp(µs, with the zone for `timestamptz`), dates Date32. Decimal and numeric become Utf8 so precision survives. uuid, json, inet, arrays, enums and unknown types become Utf8 through their text form, with a hex fallback for bytes that are not UTF-8. NULL is preserved in every column.

## Result sizes

- Table tabs page with `LIMIT/OFFSET`, 1,000 rows per page by default (300 to 20,000 selectable).
- SQL tabs stop at 500,000 rows or 512 MB and mark the result `truncated`.
- Claude gets at most 500 rows back per call (50 by default); the full result can open in a tab.

## Claude

Two entry points share the same MCP tools.

- **Chat panel (⌘K).** `chat.rs` runs the user's own `claude` CLI headless in stream-json mode, with TableView's MCP server as its only tool source, no built-in tools, none of the user's settings or hooks, and an empty working directory. It uses the user's Claude Code login.
- **Claude Code in a terminal.** Settings shows a ready-to-paste `claude mcp add` command with the URL and token.

| tool | does |
|---|---|
| `list_connections` | ids, names, kinds, env tags, read-only and Claude access flags |
| `list_tables(connection)` | schema tree |
| `describe_table(connection, table)` | columns, types, PK, indexes |
| `run_query(connection, sql, max_rows=50, show=true)` | runs read-only, optionally opens a result tab, returns result_id and the first rows |
| `get_result(result_id, offset, limit)` | pages a stored result without running the query again |
| `open_table(connection, table)` | opens a table tab |
| `open_query_tab(connection, sql)` | opens a SQL tab without running it; this is how writes reach the user |
| `visualize(result_id \| connection+sql, spec)` | opens a chart tab, at most 5,000 rows |

Read-only enforcement, in layers:

1. `guard.rs` parses the SQL and allows one SELECT, WITH, EXPLAIN (without ANALYZE) or SHOW. It rejects data-modifying CTEs and side-effect functions anywhere in the tree.
2. The query runs in a read-only transaction (Postgres `BEGIN READ ONLY`, MySQL `START TRANSACTION READ ONLY`, SQLite a `mode=ro` pool with `PRAGMA query_only`) with a 30 s timeout, and always rolls back.
3. It runs as a prepared statement, which the server will not split into several statements.
4. Connections with Claude access off are refused.
5. The server binds to 127.0.0.1 only, requires `Authorization: Bearer <token>`, and rejects any request with an `Origin` header, which blocks DNS rebinding and drive-by POSTs from web pages.

## UI

- Overlay title bar with the traffic lights over a vibrancy sidebar.
- Welcome screen: saved connections with search, right-click Connect / Edit / Delete, and the connection form (Test, Save, Connect).
- Sidebar: connection badge in the env color, table search, schema tree.
- Tabs, which can be pinned (pinned tabs reopen on connect) and renamed.
  - Table tab: Data and Structure views, filters (⌘F), sorting, paging, inline edits with pending-change highlight, review and commit (⌘S).
  - SQL tab: editor (⌘↵ runs the statement under the cursor, ⇧⌘↵ runs all), result grid, chart builder.
  - Chart tab: opened by `visualize`.
- Row inspector; status bar with row count, timing and pending edits.
- Settings (⌘,), keyboard shortcuts sheet (⇧⌘/, see [SHORTCUTS.md](SHORTCUTS.md)), and a macOS menu bar built in `main.tsx`.

## Testing

- `cargo test` runs the unit tests in `db/`, `edits.rs` and `guard.rs` (SQL gate, browse SQL, edit SQL, decoding).
- `TV_ITEST=1 cargo test` also runs `itest.rs` against the seeded containers (Postgres on 127.0.0.1:55432, MySQL on 127.0.0.1:53306) and a temp SQLite file. It covers type mapping and NULLs across protocols, introspection, commits and conflict detection, Claude read-only enforcement, truncation and cancel, and MCP auth (no token gives 401, an Origin header gives 403). See [CONTRIBUTING.md](../CONTRIBUTING.md).
