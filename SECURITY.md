# Security

## Reporting a problem

Please report security issues privately through GitHub's **Report a vulnerability** button on this repository (Security tab → Advisories). Don't open a public issue for anything exploitable. Include the TableView version, the database kind, and the smallest steps that show the problem. You should hear back within a week.

## What TableView protects

TableView holds database credentials and lets Claude read your databases. The design goal is that Claude, and anything Claude reads, can **read** the connections you allow it to, and **cannot** change data, run programs, read local files, or send data anywhere on its own.

### Threats it is built to resist

| Threat | Defense |
|---|---|
| Hostile content stored in the database (prompt injection the chat Claude reads) | Claude's only tools are TableView's MCP tools. Queries pass a SQL gate and run in a read-only transaction that always rolls back. Writes can only be handed to you as SQL in an editor tab, labelled as written by Claude and not run. The context block sent with each message quotes names and SQL so data cannot pose as you. Links in Claude's replies show the full URL and ask before opening. The chat renderer allows no images, forms, styles or frames. |
| Hostile SQL from Claude | One statement only (SELECT, WITH, EXPLAIN without ANALYZE, SHOW). Function names are checked after unquoting (Postgres `U&"..."` escaped names are refused), against a denylist of side-effect, file, lock, sleep, replication and SQL-in-a-string functions (`query_to_xml`, `ts_stat`, `dblink`). Data-modifying CTEs, locking reads, `INTO`, and MySQL `/*! */` and `/*+ */` comments are refused. It runs as a prepared statement in `BEGIN READ ONLY` / `START TRANSACTION READ ONLY`, or on a `mode=ro` + `query_only` SQLite connection, with a 30 s timeout (SQLite statements interrupt themselves at the deadline) and a 64 MB result cap. Session advisory locks are released afterwards. |
| Malicious web pages (CSRF, DNS rebinding to the local MCP port) | The MCP server binds 127.0.0.1 only, requires a random bearer token, refuses any request carrying an `Origin` header, and refuses any `Host` that is not `127.0.0.1`, `localhost` or `[::1]`. |
| Other local users | The data folder is 0700. `settings.json`, `connections.json` and `chat-mcp.json`, which hold the MCP token and connection details, are created 0600. Database passwords live in the macOS Keychain. |
| Script injected into the webview | A strict CSP (`script-src 'self'`, no `eval`, no frames). The capability set is limited to opening http(s)/mailto/tel URLs and the native open/ask dialogs. The Claude CLI path must be an absolute path to a file named `claude`, and model and session values that could be read as CLI flags are refused. |
| Chat CLI escaping its sandbox | `claude` runs with `--tools ""`, `--setting-sources ""` (none of your settings, hooks or plugins), `--strict-mcp-config` with only TableView's server, and an empty private working directory. The token is removed from any CLI output shown in the app. |

### Limits you should know

- **The denylist cannot know your extensions or your own functions.** A user-defined or extension function with side effects that a read-only transaction doesn't stop (sending mail, calling HTTP, writing outside the database) can be called by Claude. **Connect with a least-privilege, read-only database role** for any connection Claude may use, and turn Claude access off (per connection) where that isn't possible. Mark production connections `prod` so they default to read-only with Claude off.
- **Claude can carry data between connections.** It can read connection A and put the values in query text sent to connection B. If B's server is hostile or logs queries somewhere you don't control, that is a way out. Enable Claude only on connections you trust equally.
- Queries Claude runs still cost server time (up to 30 s each) and app memory (up to 64 MB each, 1.5 GB of results in total).
- The "read-only" connection setting is enforced by a session setting on Postgres and MySQL. It guards against mistakes, not against SQL that you type yourself and that changes the session back. Use database permissions for a hard guarantee.
- Anyone who can run code as your macOS user can read the MCP token and drive TableView's tools. That is outside this threat model.
- Claude's SQL tabs are not run until you run them. Read them before you do, especially when a conversation touched untrusted data.
- TLS defaults to "preferred" for Postgres and MySQL. Set it to "require" for any server reached over a network you don't control.
