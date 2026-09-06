# Contributing

Use Node.js 22+, `npm ci`, `npm run build`, then `npm test`. Set `HOYA_BINARY`
to run the real JS/WASM integration suite (required in CI).

Commit source, deliberate test fixtures and dependency lockfiles. Keep build
outputs, downloaded engine checkouts, coverage, local data and issue-export
scratch files out of Git. Generate temporary assets under the OS temporary
directory; the Rust WASM integration test already does this.

Before committing, inspect `git status --short`, `git diff --cached --stat` and
`git diff --cached --check`. Stage named paths instead of the whole workspace.
GitHub issues hold current work status; do not check in generated issue snapshots.
