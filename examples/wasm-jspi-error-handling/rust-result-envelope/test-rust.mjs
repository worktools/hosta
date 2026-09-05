// Verifies the Rust "Result<T,E> over JSON envelope" pattern actually runs under
// real JSPI stack-switching in Node — not just that it compiles.
//
// Run: node --experimental-wasm-jspi test-rust.mjs
import { readFile } from "node:fs/promises";

function readCStr(memory, ptr) {
  const buf = new Uint8Array(memory.buffer, ptr);
  let end = 0;
  while (buf[end] !== 0) end++;
  return new TextDecoder().decode(buf.subarray(0, end));
}

// Rust `&str` is a (ptr, len) fat pointer — NOT null-terminated — so the `fetch`
// import (which receives ptr+len for the url) must be read by length, unlike the
// null-terminated envelope strings that `alloc`/`main` hand back.
function readStrByLen(memory, ptr, len) {
  const buf = new Uint8Array(memory.buffer, ptr, len);
  return new TextDecoder().decode(buf);
}

function writeCStr(memory, alloc, str) {
  const encoded = new TextEncoder().encode(str);
  const ptr = alloc(encoded.length + 1);
  const view = new Uint8Array(memory.buffer, ptr, encoded.length + 1);
  view.set(encoded);
  view[encoded.length] = 0;
  return ptr;
}

// `shouldFail` simulates the upstream HTTP call failing, to prove the Rust
// `Result`-based `hosta_fetch` correctly turns a `{"ok":false,...}` envelope
// into `Err(...)` and propagates it via `?` up to `main()`.
async function run(shouldFail) {
  const wasm = await readFile(new URL("./module.wasm", import.meta.url));
  let memory;
  let alloc;

  const imports = {
    env: {
      fetch: new WebAssembly.Suspending(async (urlPtr, urlLen) => {
        const url = readStrByLen(memory, urlPtr, urlLen);
        console.log(`  [host] fetch(${JSON.stringify(url)}) called`);
        // Simulate network I/O so we actually exercise the suspend/resume path.
        await new Promise((r) => setTimeout(r, 10));
        const envelope = shouldFail
          ? `{"ok":false,"error":{"code":"FETCH_ERROR","message":"simulated failure"}}`
          : `{"ok":true,"data":"hello from host"}`;
        return writeCStr(memory, alloc, envelope);
      }),
    },
  };

  const { instance } = await WebAssembly.instantiate(wasm, imports);
  memory = instance.exports.memory;
  alloc = instance.exports.alloc;

  const wrappedMain = WebAssembly.promising(instance.exports.main);
  const resultPtr = await wrappedMain();
  return readCStr(memory, resultPtr);
}

const okResult = await run(false);
console.log("success-path result:", okResult);
if (!okResult.includes('"ok":true') || !okResult.includes("hello from host")) {
  throw new Error(`unexpected success-path result: ${okResult}`);
}

const errResult = await run(true);
console.log("error-path result:  ", errResult);
if (!errResult.includes('"ok":false') || !errResult.includes("FETCH_ERROR")) {
  throw new Error(`unexpected error-path result: ${errResult}`);
}

console.log(
  "\nOK: Rust Result<T,E>-over-envelope pattern verified under real JSPI.",
);
