# Hosta CLI (preview)

The CLI is the primary operation interface for agents. It talks only to Hosta
HTTP APIs and never reads the platform database or runs guest code itself.
UI interaction is not required. All commands except `--help` emit one JSON
object on stdout, including failures. No prompts or automatic retries occur.

```sh
npm ci
npm link                         # optional; otherwise use node bin/hosta.mjs
hosta --help
hosta --version
```

Configure `HOSTA_URL` (default `http://127.0.0.1:4173`) and optional
`HOSTA_API_TOKEN`. The latter must match the server when configured. `invoke`
uses a separate `HOSTA_WEBHOOK_KEY`; avoid putting keys into shell history or
shared logs. `HOYA_AUTH_TOKEN` belongs to the server, not the CLI.

## Command-line walkthrough

Start the independent Hoya v1 engine as described in its `docs/engine-v1.md`.
Then start Hosta (the working directory locates frontend assets):

```sh
export HOYA_URL=http://127.0.0.1:3000
export HOYA_AUTH_TOKEN=local-example
npm start
```

In another shell:

```sh
node bin/hosta.mjs doctor --json
node bin/hosta.mjs apps create --name echo --idempotency-key create-echo --json
# Take data.id from the JSON response as APP_ID.
node bin/hosta.mjs versions upload --app APP_ID --source examples/echo.js --json
# Take data.id from the upload response as VERSION_ID.
printf '%s' '{"value":7}' | node bin/hosta.mjs run --version VERSION_ID --input - --json
node bin/hosta.mjs publish --app APP_ID --version VERSION_ID --json
# Save data.webhookKey from this first response securely as HOSTA_WEBHOOK_KEY.
# Take data.code from apps get/list as APP_CODE.
printf '%s' '{"value":8}' | node bin/hosta.mjs invoke --code APP_CODE --input - --json
node bin/hosta.mjs runs list --app APP_ID --limit 20 --json
node bin/hosta.mjs runs get --run RUN_ID --json
node bin/hosta.mjs runs logs --run RUN_ID --json
```

Publication requires successful explicit execution of the exact version ID.
There is no implicit latest-version publish. Re-publishing updates the version
without rotating the key; only first publication returns the key. Rotation,
rollback and disable commands are still tracked in issue #5.

For WASM, compile the no-dependency example locally and upload its binary:

```sh
rustup target add wasm32-unknown-unknown --toolchain stable
rustc +stable --edition=2021 --target wasm32-unknown-unknown --crate-type cdylib \
  -O examples/echo.rs -o /tmp/hosta-echo.wasm
node bin/hosta.mjs apps create --name wasm-echo --runtime wasm --json
node bin/hosta.mjs versions upload --app APP_ID --runtime wasm --source /tmp/hosta-echo.wasm --json
# Run, publish and invoke using the same commands as JS.
```

WASM exports `memory` and `hoya_main() -> i32` under `hoya-json-v1`; the return
pointer addresses NUL-terminated JSON. The example echoes actual input.
The old integer-returning `main` template is not compatible and must be rebuilt.
Untrusted source compilation in Hosta is disabled by default. The optional
`HOSTA_ENABLE_LOCAL_COMPILER=1` path is for trusted local sources only, pending
isolated build support (#7). MoonBit is not yet verified for v1.

## Machine contract

The response envelope is `{schemaVersion:"1",status,data,error}`. Error includes
`code`, `message`, `retryable`; execution failures keep the run (including its
ID) in `data`. Capture stdout as JSON. `--json` is accepted explicitly, and JSON
is also the default. `--help` is human-readable; `--version` returns JSON.

| Exit | Meaning |
| --- | --- |
| 0 | Success |
| 1 | API rejected the operation |
| 2 | Usage, file or input JSON error |
| 3 | Authentication failure |
| 4 | Guest execution or version validation failed |
| 5 | Transport, deadline or unavailable engine |
| 6 | API protocol/response format failure |

`--source FILE|-` accepts UTF-8 JS or WASM bytes; `--input FILE|-` accepts JSON.
Only one argument may read stdin. `--timeout MS` bounds service requests (default
10s). The current run/invoke API is synchronous. `--wait` also polls queued/running
records if returned, using a single deadline; a completed guest failure exits
nonzero even when HTTP was successful. No unimplemented asynchronous generation
or cancellation commands are advertised.

Idempotency keys are supported only for app/version creation. Reuse a key with
the same payload to retrieve the same response; different payloads return 409.
Records are retained for 24 hours (up to 1000). A pending record after interruption
returns `OUTCOME_UNKNOWN`: inspect app/version state rather than blindly choosing
a new key. This conservative recovery does not provide general exactly-once
execution or replace the future transactional storage work (#10).

For network failure after `invoke` or `publish`, inspect state before retrying;
the server may already have executed it. General async jobs, cancellation,
secrets management, migration to transactional storage and full deployment
governance remain tracked in their issues.

## Verification

```sh
npm test                       # CLI/API fixture tests; smoke explicitly skipped without HOYA_BINARY
npm run build
HOYA_BINARY=/absolute/path/to/hoya/target/debug/hoya npm run test:smoke
```

The smoke starts temporary Hoya/Hosta instances with fresh data, builds real
Rust WASM and exercises both runtimes via spawned CLI processes. It also checks
that a JS infinite loop times out, later runs work, and an engine outage does
not prevent querying Hosta's applications. No browser, model key or production
data is used. Real smoke requires Rust stable + wasm32-unknown-unknown and the
Hoya v1 binary; a skipped smoke is not a passing real-engine verification.
