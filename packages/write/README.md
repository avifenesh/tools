# @agent-sh/harness-write

Atomic file write + `edit` + `multiedit` with read-before-edit ledger, OLD_STRING_NOT_UNIQUE match locations, and fuzzy candidate suggestions on miss.

Part of the [`@agent-sh/harness-*`](https://github.com/avifenesh/tools) monorepo — see the top-level README for architectural context and the full tool surface.

## Install

```sh
npm install @agent-sh/harness-write
```

Requires Node ≥ 20.

## Usage

```ts
import { edit, InMemoryLedger } from "@agent-sh/harness-write";

const ledger = new InMemoryLedger();
// ... after the model Reads the file, the read-executor records into ledger ...
const r = await edit(
  { path: "src/index.ts", old_string: "old", new_string: "new" },
  { cwd: process.cwd(), permissions: { roots: [process.cwd()], sensitivePatterns: [] }, ledger },
);
```

## Contract

The full contract — input shape, output discriminated-union, error codes, permission model, and acceptance tests — lives in [`agent-knowledge/design/write.md`](https://github.com/avifenesh/tools/blob/main/agent-knowledge/design/write.md). Changes to this package must stay in sync with that spec.

## License

MIT © Avi Fenesh
