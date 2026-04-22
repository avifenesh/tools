use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LedgerEntry {
    pub path: String,
    pub sha256: String,
    pub mtime_ms: u64,
    pub size_bytes: u64,
    pub timestamp_ms: u64,
}

/// Mirror of the TS `Ledger` surface: keyed by path, most-recent wins.
pub trait Ledger: Send + Sync + std::fmt::Debug {
    fn get_latest(&self, path: &str) -> Option<LedgerEntry>;
    fn record(&self, entry: LedgerEntry);
}

#[derive(Default)]
pub struct InMemoryLedger {
    inner: Arc<Mutex<HashMap<String, LedgerEntry>>>,
}

impl InMemoryLedger {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl std::fmt::Debug for InMemoryLedger {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InMemoryLedger").finish()
    }
}

impl Ledger for InMemoryLedger {
    fn get_latest(&self, path: &str) -> Option<LedgerEntry> {
        self.inner.lock().unwrap().get(path).cloned()
    }
    fn record(&self, entry: LedgerEntry) {
        self.inner
            .lock()
            .unwrap()
            .insert(entry.path.clone(), entry);
    }
}
