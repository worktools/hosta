// Verifies MoonBit's `wasm-gc` + JS String Builtins path actually runs under
// real JSPI in Node — proving `String` params/returns cross the host boundary
// as plain JS strings, with no manual linear-memory pointer marshaling.
//
// Run: node --experimental-wasm-jspi test-moonbit.mjs
import { readFile } from "node:fs/promises";

const wasmPath = new URL(
  "./_build/wasm-gc/release/build/jspi-demo.wasm",
  import.meta.url,
);

async function run(shouldFail) {
  const wasm = await readFile(wasmPath);

  const imports = {
    env: {
      // `url` arrives as a plain JS string — no ptr/len, no memory reads.
      fetch: new WebAssembly.Suspending(async (url) => {
        console.log(`  [host] fetch(${JSON.stringify(url)}) called`);
        await new Promise((r) => setTimeout(r, 10));
        return shouldFail
          ? `{"ok":false,"error":{"code":"FETCH_ERROR","message":"simulated failure"}}`
          : `{"ok":true,"data":"hello from host"}`;
      }),
    },
  };

  const { instance } = await WebAssembly.instantiate(wasm, imports, {
    // MoonBit's JS-String-Builtins mode imports its embedded string literal
    // constants from a synthetic module (default name "_"); this option tells
    // V8 to synthesize that module itself instead of us providing it by hand.
    importedStringConstants: "_",
    // Wires the actual "wasm:js-string" builtin functions (length, concat,
    // charCodeAt, ...) that JS-String-Builtins-compiled code calls into.
    builtins: ["js-string"],
  });
  const wrappedMain = WebAssembly.promising(instance.exports.main);
  // Returns a plain JS string directly — no readCStr/writeCStr needed.
  return await wrappedMain();
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
  "\nOK: MoonBit wasm-gc + JS-String-Builtins + JSPI string ABI verified.",
);
