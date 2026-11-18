//! Gate for SQL that arrives over MCP. It is one layer of several: the query
//! also runs in a read-only transaction with a timeout, on a prepared statement
//! that the server will not split into several statements.

use sqlparser::ast::{Statement, Visit, Visitor};
use sqlparser::dialect::{Dialect, MySqlDialect, PostgreSqlDialect, SQLiteDialect};
use sqlparser::parser::Parser;
use std::ops::ControlFlow;

use crate::config::DbKind;

/// Functions with side effects or file/network access that a read-only
/// transaction does not stop, or that run SQL handed to them as text (which
/// this parser never sees).
const DENY_FUNCTIONS: &[&str] = &[
    "pg_terminate_backend",
    "pg_cancel_backend",
    "pg_reload_conf",
    "pg_rotate_logfile",
    "nextval",
    "setval",
    "set_config",
    "pg_stat_file",
    "pg_notify",
    "pg_promote",
    "dblink",
    "pg_switch_wal",
    "pg_create_restore_point",
    "txid_current",
    "pg_current_xact_id",
    "pg_logical_emit_message",
    "pg_log_backend_memory_contexts",
    "pg_import_system_collations",
    "query_to_xml",
    "query_to_xmlschema",
    "query_to_xml_and_xmlschema",
    "cursor_to_xml",
    "cursor_to_xmlschema",
    "ts_stat",
    "ts_rewrite",
    "crosstab",
    "crosstab2",
    "crosstab3",
    "crosstab4",
    "connectby",
    "xpath_table",
    "get_lock",
    "release_lock",
    "release_all_locks",
    "load_file",
    "sleep",
    "benchmark",
    "master_pos_wait",
    "source_pos_wait",
    "wait_for_executed_gtid_set",
    "wait_until_sql_thread_after_gtids",
    "load_extension",
    "writefile",
    "readfile",
    "fts3_tokenizer",
    "edit",
];

/// Whole families, matched by prefix: sleeps, advisory locks, large objects,
/// server files and directories, replication and WAL control, stats resets.
const DENY_PREFIXES: &[&str] = &[
    "pg_sleep",
    "pg_advisory",
    "pg_try_advisory",
    "lo_",
    "pg_read_",
    "pg_ls_",
    "pg_file_",
    "dblink_",
    "pg_stat_reset",
    "pg_wal_",
    "pg_backup_",
    "pg_create_",
    "pg_drop_",
    "pg_replication_",
    "pg_logical_",
    "pg_copy_",
    "pg_sequence_",
];

fn denied(base: &str) -> bool {
    DENY_FUNCTIONS.contains(&base) || DENY_PREFIXES.iter().any(|p| base.starts_with(p))
}

struct FnFinder {
    denied: Option<String>,
    statements: usize,
}

impl FnFinder {
    fn check(&mut self, name: &sqlparser::ast::ObjectName) -> ControlFlow<()> {
        // The unquoted value of the last part, so `sleep`, [load_extension] and
        // U&"pg_sleep" compare the same as their bare spellings.
        let base = match name.0.last() {
            Some(sqlparser::ast::ObjectNamePart::Identifier(i)) => i.value.to_lowercase(),
            Some(other) => other.to_string().to_lowercase(),
            None => return ControlFlow::Continue(()),
        };
        if denied(&base) {
            self.denied = Some(base);
            return ControlFlow::Break(());
        }
        ControlFlow::Continue(())
    }
}

impl Visitor for FnFinder {
    type Break = ();
    fn pre_visit_expr(&mut self, expr: &sqlparser::ast::Expr) -> ControlFlow<()> {
        if let sqlparser::ast::Expr::Function(f) = expr {
            return self.check(&f.name);
        }
        ControlFlow::Continue(())
    }
    fn pre_visit_table_factor(&mut self, t: &sqlparser::ast::TableFactor) -> ControlFlow<()> {
        match t {
            sqlparser::ast::TableFactor::Table {
                name,
                args: Some(_),
                ..
            } => self.check(name),
            sqlparser::ast::TableFactor::Function { name, .. } => self.check(name),
            _ => ControlFlow::Continue(()),
        }
    }
    fn pre_visit_statement(&mut self, _s: &Statement) -> ControlFlow<()> {
        // A statement nested inside the query (a data-modifying CTE) shows up here.
        self.statements += 1;
        ControlFlow::Continue(())
    }
}

fn dialect(kind: DbKind) -> Box<dyn Dialect> {
    match kind {
        DbKind::Postgres => Box::new(PostgreSqlDialect {}),
        DbKind::Mysql => Box::new(MySqlDialect {}),
        DbKind::Sqlite => Box::new(SQLiteDialect {}),
    }
}

/// Returns Ok when `sql` is a single read-only statement Claude may run.
pub fn check_read_only(kind: DbKind, sql: &str) -> Result<(), String> {
    let lowered = sql.to_ascii_lowercase();
    // MySQL runs the contents of /*! */ comments and obeys /*+ */ optimizer
    // hints, which can lift max_execution_time. The parser's view of these is
    // not the server's, so refuse them outright.
    if kind == DbKind::Mysql && (sql.contains("/*!") || sql.contains("/*+")) {
        return Err(
            "MySQL executable comments (/*! */) and optimizer hints (/*+ */) are not allowed"
                .into(),
        );
    }
    // Postgres decodes escapes in U&"..." identifiers (U&"pg\005Fsleep" is
    // pg_sleep); the parser does not, so a denied name could hide behind one.
    if kind == DbKind::Postgres && lowered.contains("u&\"") {
        return Err(
            "Unicode-escaped identifiers (U&\"...\") are not allowed; write the name plainly"
                .into(),
        );
    }
    for word in ["into outfile", "into dumpfile"] {
        if lowered.contains(word) {
            return Err(format!(
                "`{}` is not allowed in read-only queries",
                word.trim()
            ));
        }
    }
    let stmts = Parser::parse_sql(dialect(kind).as_ref(), sql).map_err(|e| {
        format!("could not parse the query, so it was not run ({e}). Use a single standard SELECT.")
    })?;
    if stmts.len() != 1 {
        return Err(format!(
            "exactly one statement is allowed, got {}",
            stmts.len()
        ));
    }
    let stmt = &stmts[0];
    let ok = match stmt {
        Statement::Query(q) => {
            let text = q.to_string().to_ascii_lowercase();
            !text.contains(" for update")
                && !text.contains(" for share")
                && !text.contains(" into ")
        }
        Statement::Explain {
            analyze, statement, ..
        } => {
            !*analyze
                && !lowered.contains("analyze")
                && matches!(statement.as_ref(), Statement::Query(_))
        }
        Statement::ExplainTable { .. } => true,
        Statement::ShowTables { .. }
        | Statement::ShowColumns { .. }
        | Statement::ShowVariable { .. }
        | Statement::ShowVariables { .. }
        | Statement::ShowCreate { .. }
        | Statement::ShowDatabases { .. }
        | Statement::ShowSchemas { .. }
        | Statement::ShowStatus { .. }
        | Statement::ShowViews { .. } => true,
        _ => false,
    };
    if !ok {
        return Err("only SELECT, WITH, EXPLAIN (without ANALYZE) and SHOW are allowed".into());
    }
    let mut finder = FnFinder {
        denied: None,
        statements: 0,
    };
    let _ = stmt.visit(&mut finder);
    if let Some(f) = finder.denied {
        return Err(format!(
            "function `{f}` is not allowed in read-only queries"
        ));
    }
    let nested = finder.statements
        - if matches!(stmt, Statement::Explain { .. }) {
            2
        } else {
            1
        };
    if nested > 0 {
        return Err("data-modifying statements inside a query are not allowed".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use DbKind::*;

    #[test]
    fn allows_plain_reads() {
        for (k, q) in [
            (Postgres, "select * from customers where id = 1"),
            (Postgres, "with t as (select 1 as x) select x from t"),
            (Postgres, "explain select 1"),
            (Mysql, "SELECT `id` FROM `customers` LIMIT 5"),
            (Mysql, "SHOW TABLES"),
            (Sqlite, "select count(*) from orders"),
            (
                Postgres,
                "select lower(name), log(2, 8), pg_size_pretty(pg_database_size('shop')) from customers",
            ),
            (Postgres, "select * from pg_stat_activity"),
            (Mysql, "SELECT `sleep`, lock_mode FROM t"),
            (Mysql, "select 1 /* a plain comment */"),
        ] {
            assert!(check_read_only(k, q).is_ok(), "{q}");
        }
    }

    #[test]
    fn blocks_writes_and_escapes() {
        for (k, q) in [
            (Postgres, "COMMIT; DROP TABLE customers"),
            (Postgres, "select 1; delete from customers"),
            (Postgres, "delete from customers"),
            (Postgres, "update customers set name = 'x'"),
            (Postgres, "SET TRANSACTION READ WRITE"),
            (Postgres, "select pg_terminate_backend(123)"),
            (Postgres, "select nextval('customers_id_seq')"),
            (Postgres, "select * from customers for update"),
            (Postgres, "explain analyze delete from customers"),
            (Postgres, "copy customers to program 'rm -rf /'"),
            (Postgres, "create temp table x as select 1"),
            (Postgres, "select * into newtable from customers"),
            (Postgres, "select public.pg_terminate_backend(1)"),
            (Mysql, "SELECT * FROM customers INTO OUTFILE '/tmp/x'"),
            (Mysql, "SELECT GET_LOCK('a', 10)"),
            (Mysql, "KILL 12"),
            (Sqlite, "ATTACH 'file:x?mode=rwc' AS x"),
            (Sqlite, "VACUUM INTO '/tmp/x.db'"),
            (Sqlite, "select load_extension('x')"),
            (Postgres, "SELECT * FROM pg_terminate_backend(123)"),
            (
                Postgres,
                "select * from dblink_exec('dbname=shop', 'delete from customers') as t(x text)",
            ),
            (
                Postgres,
                "select * from customers, lateral pg_read_file('/etc/passwd') f",
            ),
            (
                Postgres,
                "WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d",
            ),
            (
                Postgres,
                "WITH u AS (UPDATE orders SET note = 'x' RETURNING id) SELECT count(*) FROM u",
            ),
            (Postgres, "EXPLAIN (ANALYZE) DELETE FROM customers"),
            (Postgres, "EXPLAIN (ANALYZE, BUFFERS) SELECT 1"),
        ] {
            assert!(check_read_only(k, q).is_err(), "should block: {q}");
        }
    }

    #[test]
    fn blocks_quoted_names_families_and_sql_in_strings() {
        for (k, q) in [
            // Quoted spellings of denied functions.
            (Mysql, "select `sleep`(5)"),
            (Mysql, "select `shop`.`get_lock`('a', 1)"),
            (Sqlite, "select [load_extension]('x')"),
            (Sqlite, "select `load_extension`('x')"),
            (Postgres, "select U&\"pg_sleep\"(1)"),
            (Postgres, r#"select U&"pg\005Fsleep"(1)"#),
            (Postgres, r#"select u&"pg\005fterminate_backend"(1)"#),
            (Postgres, "select * from crosstab('select 1')"),
            (Postgres, "select * from connectby('t', 'a', 'b', '1', 0)"),
            (Postgres, "select \"PG_TERMINATE_BACKEND\"(1)"),
            (Postgres, "select pg_catalog.pg_terminate_backend(1)"),
            // Functions that run SQL given as a string.
            (
                Postgres,
                "select query_to_xml('select pg_terminate_backend(1)', true, true, '')",
            ),
            (Postgres, "select * from ts_stat('select 1')"),
            (Postgres, "select cursor_to_xml('c', 1, true, true, '')"),
            // Families the exact-name list missed.
            (Postgres, "select pg_sleep_for('1 min')"),
            (Postgres, "select pg_advisory_lock_shared(1)"),
            (Postgres, "select pg_try_advisory_lock_shared(1)"),
            (Postgres, "select lo_from_bytea(0, 'x')"),
            (Postgres, "select lo_get(1)"),
            (Postgres, "select pg_ls_logdir()"),
            (Postgres, "select pg_read_file('x')"),
            (Postgres, "select pg_logical_emit_message(true, 'a', 'b')"),
            (Postgres, "select pg_stat_reset()"),
            (
                Postgres,
                "select * from pg_create_logical_replication_slot('s', 'p')",
            ),
            (Mysql, "select source_pos_wait('f', 1, 100)"),
            (Mysql, "select wait_for_executed_gtid_set('x', 100)"),
            // MySQL comments the server executes or obeys.
            (Mysql, "select /*+ MAX_EXECUTION_TIME(999999) */ 1"),
            (Mysql, "select 1 /*!50000 , 2 */"),
        ] {
            assert!(check_read_only(k, q).is_err(), "should block: {q}");
        }
    }
}
