# RFC 0010：WASM Host 错误处理与 JSPI Reject 语义

- 状态：Proposed（探索已验证，尚未接入生产代码）
- 日期：2026-08-12
- 相关代码：[`src/wasm-bridge.ts`](../src/wasm-bridge.ts)、[`src/executor.ts`](../src/executor.ts)、[`src/compiler.ts`](../src/compiler.ts)、[`src/prompts.ts`](../src/prompts.ts)（`rustStarter`/`moonStarter`）
- 验证 Demo：[`examples/wasm-jspi-error-handling/`](../examples/wasm-jspi-error-handling/)

## 1. 背景

Hosta 的 WASM 运行时通过 JSPI（JavaScript Promise Integration）让 Rust/MoonBit 编译出的 WASM 程序能"同步地"调用异步的宿主能力（目前只有 `fetch`）。当前实现（`wasm-bridge.ts`）里，宿主侧的 `fetch` 导入函数：

```ts
fetch: new (WebAssembly as any).Suspending(async (urlPtr, urlLen) => {
  try {
    // ...校验 URL、请求、读取响应...
    return writeStr(JSON.stringify({ ok: true, data: text }));
  } catch (err) {
    return writeStr(JSON.stringify({ ok: false, error: { code: ..., message: ... } }));
  }
}),
```

**永远走 `resolve` 分支**——无论请求成功还是失败，都把结果编码进一段 JSON 字符串里返回，从不真正 `reject` 这个 Promise。这带来两个问题需要探索：

1. Rust 有没有更符合语言习惯的方式来处理这层"成功/失败"，而不是每次都手动解析 JSON 信封？
2. MoonBit 官方从未针对 JSPI 做过任何适配，它是否也能接入同一套协议？

## 2. JSPI 规范：reject 到底发生什么

查阅 [JSPI 官方提案文本](https://github.com/WebAssembly/js-promise-integration/blob/main/proposals/js-promise-integration/Overview.md)（Suspending functions 一节），关键结论：

> In the case of `onRejected`, throws the given value up to `frames` as an exception according to the JS API of the [Exception Handling](https://github.com/WebAssembly/exception-handling/) proposal.

也就是说，如果真的让 `fetch` 对应的 Promise reject：

- V8 不会给 WASM 一个"错误返回值"，而是把这个 JS 异常转换成 **WASM 层面的异常**（依据 wasm Exception-Handling 提案的 tag/exnref 机制），直接抛入 WASM 的调用栈；
- 如果 WASM 内部没有 `try`/`catch`（WASM 汇编层面的异常处理指令）捕获它，这个异常会**展开（unwind）整条调用栈**；
- 最终从 `WebAssembly.promising` 包裹的导出函数那里，把这次调用整体变成一次 rejected Promise（对应 `executor.ts` 里 `await wrappedFn()` 直接 throw，被外层 `catch` 兜底，`run.status` 记为 `failed`）。

结论：**reject 不是局部错误，而是整条调用链直接失败**，无法在 WASM 程序内部做"这次请求失败了，换个 URL 重试"这种局部恢复——除非该语言的工具链支持捕获这个外部异常。

## 3. Rust：能否用 `Result<T, E>`

理论上，要在 Rust 里捕获这个异常需要 wasm exception-handling 提案的编译器支持（`-C target-feature=+exception-handling` + `panic=unwind`），这在 `wasm32-unknown-unknown` 上目前仍是 **nightly-only、不稳定**的能力；而且要捕获的是"外部通过 tag 抛来的 JS 异常"，不是 Rust 自身 panic 的 unwind，工具链支持更薄弱。加上 Hosta 当前的 `rustStarter` 是 `#![no_std] #![no_main]` + `panic_handler { loop {} }`（等价于 `panic=abort`），**完全没有 unwind 能力**。

**结论：不采用"真 reject + WASM 异常捕获"的方案。**

但 `Result<T, E>` 完全可以且应该在**信封协议之上**引入——不需要 JS Promise 真的 reject，只需要在 Rust 里把"信封的 ok/err 解析"封装成返回 `Result` 的函数：

```rust
fn hosta_fetch(url: &str) -> Result<&str, HostaError> {
    let ptr = unsafe { fetch(url.as_ptr(), url.len()) };
    let raw = unsafe { read_cstr(ptr) };
    parse_envelope(raw)  // {"ok":true,...} -> Ok(..)，{"ok":false,...} -> Err(..)
}

fn handle(input: &str) -> Result<&str, HostaError> {
    let body = hosta_fetch("https://api.example.com")?;  // 可以用 ?
    Ok(body)
}
```

已在 [`examples/wasm-jspi-error-handling/rust-result-envelope`](../examples/wasm-jspi-error-handling/rust-result-envelope) 完整实现并验证：编译到 `wasm32-unknown-unknown`，在 Node 里通过真实的 `WebAssembly.Suspending` + `WebAssembly.promising` 跑通成功/失败两条路径，断言最终 JSON 信封内容正确。

## 4. MoonBit：能否接入同一套协议

### 4.1 第一次尝试：模仿 Rust 的裸指针 ABI —— 失败

MoonBit 编译到经典 `--target wasm`（线性内存模型，`(export "memory")`，自带 `tlsf` 分配器，这点已实测确认）。尝试模仿 Rust 把字符串的裸指针传给 host import 时，**直接把 `moonc` 编译器搞崩了**（内部断言失败：`Assertion failed`）。

查官方 FFI 文档（[`language/ffi.md`](https://github.com/moonbitlang/moonbit-docs/blob/main/next/language/ffi.md)）后确认原因：经典 `Wasm` 后端的 FFI 类型表里**根本没有 `Bytes`/`String`**：

| MoonBit type | ABI（经典 Wasm 后端）|
|---|---|
| Bool / Int / UInt | i32 |
| Int64 / UInt64 | i64 |
| external type (`#external type T`) | externref |
| `FuncRef[T]` | funcref |

文档原话："Types not mentioned above do not have a stable ABI, so your code should not depend on their representations." —— 在经典 `wasm` 后端上，跨 FFI 边界传字符串/字节数组本身就没有稳定支持，Rust 那套"手写指针+长度"的路子在 MoonBit 里走不通。

### 4.2 第二次尝试：`wasm-gc` + JS String Builtins —— 验证通过

`wasm-gc` 目标的 FFI 类型表里：

| MoonBit type | ABI（Wasm GC 后端）|
|---|---|
| `String` | **`externref` iff JS string builtin is on** |

只要在 `moon.pkg` 里打开 [JS String Builtins 提案](https://github.com/WebAssembly/js-string-builtins) 支持：

```moonbit
options(
  link: { "wasm-gc": { "use-js-builtin-string": true } },
)
```

`String` 就直接对应真实的 JS 字符串（`externref`），可以这样声明 host import：

```moonbit
fn host_fetch(url : String) -> String = "env" "fetch"
```

JS 侧对应写成 `WebAssembly.Suspending(async (url: string) => envelopeJson)`——**参数和返回值直接是原生 JS 字符串**，完全不需要手动读写 `memory.buffer`。已在 [`examples/wasm-jspi-error-handling/moonbit-string-envelope`](../examples/wasm-jspi-error-handling/moonbit-string-envelope) 完整实现并验证成功/失败两条路径。

实测中额外发现：光靠编译期开关还不够，`WebAssembly.instantiate` 需要传第三个参数把 V8 侧的 JS-String-Builtins 支持显式打开，否则会报缺少 `"_"` / `"wasm:js-string"` 导入模块：

```js
await WebAssembly.instantiate(wasm, imports, {
  importedStringConstants: "_",
  builtins: ["js-string"],
});
```

MoonBit 标准库自带完整的 `moonbitlang/core/json`（`Json` 枚举 + `parse`/`stringify`），信封的构造/解析可以用原生类型完成，比 Rust `no_std` 手写字符串拼接更省事。

### 4.3 reject 语义的结论对 MoonBit 同样成立

MoonBit 目前也没有稳定的、跨 FFI 边界捕获外部异常的能力，所以和 Rust 结论一致：不采用真 reject，继续用 JSON 信封表示成功/失败。

## 5. 决策

1. **继续使用 JSON 信封协议**（`{"ok":true,"data":...}` / `{"ok":false,"error":{"code":...,"message":...}}`）表示成功/失败，`fetch` host import 在 JS 侧永远 `resolve`，不主动触发 reject。这是唯一一个**与源语言无关**、面向未来兼容 MoonBit 的方案。
2. Rust 侧可以（后续）在信封协议之上引入 `Result<T, HostaError>` 封装层，改善 `rustStarter` 的生成代码风格，但不是本 RFC 强制要求。
3. MoonBit 如果要真正接入 host `fetch` 能力，**必须**使用 `wasm-gc + use-js-builtin-string`，而不是当前生产代码里的经典 `wasm` 目标；两者需要完全不同的桥接代码（见 §6）。

## 6. 对生产代码的影响（尚未实施）

若要把 MoonBit 的 host import 能力接入生产，需要改动：

- `src/compiler.ts`：`compileWasm()` 的 MoonBit 分支，`moon build --target wasm` → `--target wasm-gc`，并在生成的 `moon.pkg.json` 里加 `"use-js-builtin-string": true`。
- `src/wasm-bridge.ts`：现有 `buildWasmImports`/`readWasmStr`/`parseWasmEnvelope` 是为 Rust 裸指针 ABI 设计的（依赖 `memory`/`alloc` 导出），需要为 MoonBit 新增一套基于普通 `String` 参数/返回值的桥接函数，且 `WebAssembly.instantiate` 调用需要加上 `importedStringConstants`/`builtins` 选项。
- `src/executor.ts`：需要按 `version.language`（`"rust"` vs `"moonbit"`）选择对应的桥接实现。
- `src/prompts.ts`：`moonStarter` 目前只有一个空的 `pub fn run() -> Int { 0 }` 占位，尚未声明任何 host import，需要补全为 `pub fn run() -> String` + `host_fetch`/`host_log` 等导入声明。

**本 RFC 本身不改动上述生产代码**，仅记录探索结论和已验证的最小 demo，供后续实现参考。

## 7. 未覆盖 / 待验证的点

- 两个 demo 都是本地单文件编译跑通，没有接入 `src/compiler.ts` 实际的临时目录编译管线。
- Rust demo 的 no_std 手写 JSON 转义只覆盖了 `"`/`\`，未覆盖控制字符、非 ASCII 字符的完整转义规则。
- 未测试 `wasm-gc` + JSPI + JS-String-Builtins 三者叠加在更复杂场景（多次挂起、并发调用）下的行为，目前只验证了单次 `fetch` 调用的成功/失败路径。
- 未测试 MoonBit 的 `Result[T, E]` 与 `raise`/`try`/`catch` 错误处理机制在更复杂的调用链中的组合方式。
