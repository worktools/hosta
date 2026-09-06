# Preview compatibility

This Hosta branch requires Hoya execution protocol `1`, WASM ABI `hoya-json-v1`
and JavaScript script-style `main(input, ctx)`.

The real-engine CI fixture pins Hoya revision
`75dd1f7c31a7ef3ced0a068bbde42f1f290d942e` (the engine-v1 PR). This is an immutable
integration fixture, not a released engine version. Upgrade the pin only after
the CLI-to-real-engine tests pass; release tags and a supported release matrix
will follow the engine release issue.

The client discovers capabilities before execution and rejects incompatible
engines or mismatched run IDs/hashes. JS hashes cover UTF-8 source; WASM hashes
cover decoded bytes. Old Hosta WASM versions using integer-returning `main`
must be rebuilt from the v1 example; existing artifacts are never rewritten
in place. Keep old versions for history and explicitly upload/validate/publish
a new version.

JS code must use the documented runtime subset. There is no implicit fallback
to Node vm/WASM. If Hoya is down, runs become `internal_error` with a stable
engine error and run ID while management queries remain available.
