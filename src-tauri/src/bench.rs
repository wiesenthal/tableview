//! Benchmarks for the README, run against the demo database in tests/demo:
//! `TV_BENCH=1 cargo test --release bench -- --nocapture --test-threads=1`.
//! Each scenario runs the same code path as the SQL editor, three times, and
//! reports the median wall time plus the Arrow payload the webview receives.

use std::sync::Arc;
use std::time::Instant;

use crate::config::{ConnectionConfig, DbKind, Store};
use crate::state::AppState;

fn demo() -> Option<Arc<AppState>> {
    if std::env::var("TV_BENCH").as_deref() != Ok("1") {
        return None;
    }
    let dir = std::env::temp_dir().join(format!("tv-bench-{}", uuid::Uuid::new_v4().simple()));
    let st = Arc::new(AppState::new(Store::new(dir).unwrap()).unwrap());
    *st.connections.lock().unwrap() = vec![ConnectionConfig {
        id: "demo".into(),
        name: "demo".into(),
        kind: DbKind::Postgres,
        host: "127.0.0.1".into(),
        port: 55433,
        user: "postgres".into(),
        database: "acme".into(),
        file_path: String::new(),
        ssl_mode: "disable".into(),
        env: "local".into(),
        read_only: false,
        allow_claude: true,
    }];
    Some(st)
}

#[tokio::test]
async fn bench_editor_queries() {
    let Some(st) = demo() else { return };
    let scenarios = [
        ("1M invoices, 6 columns", "SELECT * FROM invoices"),
        (
            "500k events with jsonb",
            "SELECT * FROM events LIMIT 500000",
        ),
        ("400k users, 8 columns", "SELECT * FROM users"),
        (
            "aggregate over 5M events",
            "SELECT name, count(*), avg((properties->>'ms')::int) FROM events GROUP BY name",
        ),
    ];
    for (label, sql) in scenarios {
        let mut times = vec![];
        let mut rows = 0;
        let mut bytes = 0;
        for i in 0..3 {
            let t = Instant::now();
            let r = st
                .run_editor_query("demo", &format!("bench-{i}"), sql, "q")
                .await
                .unwrap();
            times.push(t.elapsed().as_millis());
            rows = r.row_count;
            bytes = st.results.get(&r.id).unwrap().ipc.len();
            st.results.release(&r.id);
        }
        times.sort();
        println!(
            "BENCH | {label} | {rows} rows | median {} ms | arrow {:.1} MB",
            times[1],
            bytes as f64 / 1e6
        );
    }
}

#[tokio::test]
async fn bench_open_big_table() {
    let Some(st) = demo() else { return };
    let opts = crate::db::BrowseOptions {
        limit: 1000,
        offset: 0,
        filters: vec![],
        order_by: None,
        supersede: Default::default(),
    };
    let mut times = vec![];
    for _ in 0..3 {
        let t = Instant::now();
        let r = st.browse("demo", "public", "events", &opts).await.unwrap();
        times.push(t.elapsed().as_millis());
        st.results.release(&r.id);
    }
    times.sort();
    println!(
        "BENCH | open 5M-row table (first 1000 rows) | median {} ms",
        times[1]
    );
}
