use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use arrow_array::RecordBatch;
use serde::Serialize;

use crate::db::ResultColumn;

#[derive(Debug, Clone, Serialize)]
pub struct QueryResult {
    pub id: String,
    pub connection_id: String,
    pub sql: String,
    pub columns: Vec<ResultColumn>,
    pub row_count: usize,
    pub elapsed_ms: u64,
    pub truncated: bool,
    pub rows_affected: Option<u64>,
    /// For an unfiltered table page: the database's estimate of the table's row
    /// count, so the UI need not run COUNT(*) over a huge table.
    pub estimated_rows: Option<i64>,
    /// Set when the result is a page of one table, so edits can map back to it.
    #[serde(skip)]
    pub table: Option<(String, String)>,
}

pub struct Stored {
    pub meta: QueryResult,
    /// Kept as the Vec it was written into: converting to `Arc<[u8]>` copies it.
    pub ipc: Vec<u8>,
}

impl Stored {
    pub fn batch(&self) -> anyhow::Result<RecordBatch> {
        let mut reader =
            arrow_ipc::reader::StreamReader::try_new(std::io::Cursor::new(&self.ipc[..]), None)?;
        match reader.next() {
            Some(b) => Ok(b?),
            None => Ok(RecordBatch::new_empty(reader.schema())),
        }
    }
}

/// Results kept for the grid and for MCP follow-ups, capped by total bytes.
/// The UI releases a result when its tab closes or reruns, so eviction only
/// touches results nobody is looking at unless the cap is exceeded.
pub struct ResultStore {
    inner: Mutex<(VecDeque<Arc<Stored>>, usize)>,
    /// Results nobody is looking at (Claude's unshown queries); evicted first.
    ephemeral: Mutex<std::collections::HashSet<String>>,
    cap_bytes: usize,
}

impl ResultStore {
    pub fn new(cap_bytes: usize) -> Self {
        ResultStore {
            inner: Mutex::new((VecDeque::new(), 0)),
            ephemeral: Mutex::new(Default::default()),
            cap_bytes,
        }
    }

    pub fn put(&self, meta: QueryResult, ipc: Vec<u8>) -> Arc<Stored> {
        let stored = Arc::new(Stored { meta, ipc });
        let mut g = self.inner.lock().unwrap();
        g.1 += stored.ipc.len();
        g.0.push_back(stored.clone());
        let mut eph = self.ephemeral.lock().unwrap();
        while g.1 > self.cap_bytes && g.0.len() > 1 {
            let i =
                g.0.iter()
                    .position(|s| eph.contains(&s.meta.id))
                    .unwrap_or(0);
            if let Some(old) = g.0.remove(i) {
                g.1 -= old.ipc.len();
                eph.remove(&old.meta.id);
            }
        }
        stored
    }

    pub fn get(&self, id: &str) -> Option<Arc<Stored>> {
        self.inner
            .lock()
            .unwrap()
            .0
            .iter()
            .find(|s| s.meta.id == id)
            .cloned()
    }

    pub fn mark_ephemeral(&self, id: &str) {
        self.ephemeral.lock().unwrap().insert(id.to_string());
    }

    pub fn release(&self, id: &str) {
        let mut g = self.inner.lock().unwrap();
        if let Some(i) = g.0.iter().position(|s| s.meta.id == id) {
            let s = g.0.remove(i).unwrap();
            g.1 -= s.ipc.len();
        }
    }
}
