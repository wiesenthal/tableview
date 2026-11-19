# Learnings

## Build / install
- `src-tauri/Cargo.toml` uses `edition = "2024"`, which needs Rust 1.85+. This machine had rustc 1.65 (2022) as stable; `rustup update stable` fixed it before `npm run tauri build`.
- `npm install` warns that `fsevents` install scripts aren't in `allowScripts`. It's an optional macOS file-watcher dep; the build doesn't need it approved.
- Install + open: `npm install && npm run tauri build -- --bundles app && open src-tauri/target/release/bundle/macos/TableView.app`.

## Supabase / transaction poolers (2026-11-19)
- Symptom: `prepared statement "sqlx_s_3" does not exist` (or `already exists`) opening tables on a Supabase connection. Cause: port 6543 is Supavisor in transaction mode, which moves each transaction to any free server connection; sqlx caches named statements per client connection.
- Unnamed statements do NOT fix it: sqlx looks up custom column types (enums) with a simple query between Parse and Bind, and any simple query discards the unnamed statement (`unnamed prepared statement does not exist`).
- Fix that works: per bound query, BEGIN … run … `clear_cached_statements()` … COMMIT, so parse/bind stay on one server connection and nothing named outlives the transaction. See `PgRoute` in `src-tauri/src/db/mod.rs`.
- Session state is unsafe through such a pooler: cancel-by-pid, `SET SESSION … READ ONLY`, and `pg_advisory_unlock_all()` after ROLLBACK can hit other clients' server connections.
- Local repro: `brew install pgbouncer`, pool_mode=transaction on port 6543, `max_prepared_statements = 0`, `ignore_startup_parameters = extra_float_digits,options`. Then `TV_ITEST_POOLER=127.0.0.1:6543 cargo test postgres_through_a_transaction_pooler`.
- Gotchas: `initdb`/Postgres Unix sockets fail in the long scratchpad path (>103 bytes); start with `-c unix_socket_directories=''`. Another session may already hold port 55432; check `lsof` before starting a test Postgres. `cargo fmt` reformats untouched files here (repo isn't fmt-clean), so don't run it repo-wide.
- Without MySQL/Postgres 16 available, 12 integration tests fail on plain `main` too; compare failure sets against `git stash` before blaming a change.
