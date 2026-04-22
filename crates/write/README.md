# harness-write

Atomic file write + edit + multi-edit with read-before-edit ledger, OLD_STRING_NOT_UNIQUE match locations, fuzzy candidate suggestions.

Rust port of [`@agent-sh/harness-write`](https://www.npmjs.com/package/@agent-sh/harness-write). Part of the [`harness-*`](https://github.com/avifenesh/tools) monorepo — see the top-level README for architectural context.

## Install

```toml
[dependencies]
harness-write = "0.1"
```

## Usage

```rust
use harness_write::{edit, WriteSessionConfig, InMemoryLedger};
use harness_core::PermissionPolicy;
use std::sync::Arc;
use serde_json::json;

let perms = PermissionPolicy::new(vec!["/workspace".into()]);
let ledger = Arc::new(InMemoryLedger::new());
let session = WriteSessionConfig::new("/workspace", perms, ledger);
// ... after Read, the read-executor should record into ledger ...
let r = edit(json!({ "path": "...", "old_string": "foo", "new_string": "bar" }), &session).await;
```

## Contract

The full contract lives in [`agent-knowledge/design/write.md`](https://github.com/avifenesh/tools/blob/main/agent-knowledge/design/write.md). Changes to this crate must stay in sync with that spec, and with the TypeScript sibling at [`@agent-sh/harness-write`](https://www.npmjs.com/package/@agent-sh/harness-write).

## License

MIT © Avi Fenesh
