# WASM/JSPI 错误处理验证 Demo

对应 [RFC 0010](../../RFCs/0010-wasm-jspi-error-handling.md)。这里保存的是两个**已验证可运行**的最小示例，用来回答两个问题：

1. Rust 能不能把 `fetch` host import 的错误处理封装成符合语言习惯的 `Result<T, E>`？
2. MoonBit 完全没有为 JSPI 做过专门适配，它能不能接入同一套"JSON 信封表示成功/失败"的协议？

结论：**两个语言都可以，但走的是两条不同的 ABI 路径**——这也是这两个 demo 分开存在、分别验证的原因。

## 目录

```
rust-result-envelope/       Rust · wasm32-unknown-unknown（经典线性内存）
moonbit-string-envelope/    MoonBit · wasm-gc + JS String Builtins
```

## 为什么是两条不同的路径

| | Rust (`rust-result-envelope`) | MoonBit (`moonbit-string-envelope`) |
|---|---|---|
| 编译目标 | `wasm32-unknown-unknown`（经典线性内存） | `wasm-gc`（GC 引用类型） |
| 字符串怎么过边界 | 手写 `(ptr, len)`，JS 侧手动读写 `memory.buffer` | 直接是 `externref` 包着的真实 JS 字符串，`String` 参数/返回值零拷贝直通 |
| 为什么 | 经典 `wasm` 后端的 FFI 类型表里根本没有 `Bytes`/`String`（[官方文档](https://github.com/moonbitlang/moonbit-docs/blob/main/next/language/ffi.md)明确写"不在表里的类型没有稳定 ABI"），照搬 Rust 那套裸指针会直接把编译器搞崩（已实测触发 `moonc` 内部断言失败） | `wasm-gc` 目标 + `moon.pkg` 里的 `use-js-builtin-string: true` 让 `String` 映射到真实 JS 字符串 |
| host import 声明 | `#[link(wasm_import_module = "env")] extern "C" { fn fetch(ptr: *const u8, len: usize) -> *mut u8; }` | `fn host_fetch(url : String) -> String = "env" "fetch"` |
| 错误处理惯用法 | `fn hosta_fetch(url: &str) -> Result<&str, HostaError>`，业务代码里可以用 `?` | `fn hosta_fetch(url: String) -> Result[String, (String, String)]`，同样可以用 MoonBit 原生 `Result` |

两者的共同点：**JS 宿主侧的 `fetch` 导入函数永远 `resolve`，从不真正 `reject`**——把成功/失败编码进返回的 JSON 字符串本身（`{"ok":true,"data":...}` / `{"ok":false,"error":{...}}`）。原因见 RFC：JSPI 规范里 reject 会被转成 wasm 异常，展开（unwind）整个调用栈，Rust/MoonBit 目前都没有稳定、免费的能力去局部捕获它，所以真正让它 reject 没有实际价值，只会让这次调用整体失败且无法恢复。

## 怎么跑

### Rust demo

```bash
cd rust-result-envelope
rustc +stable --target wasm32-unknown-unknown -O --crate-type cdylib main.rs -o module.wasm
node --experimental-wasm-jspi test-rust.mjs
```

### MoonBit demo

```bash
cd moonbit-string-envelope
moon build --target wasm-gc --release
node --experimental-wasm-jspi test-moonbit.mjs
```

两个 `test-*.mjs` 都会分别跑一次"成功路径"和"失败路径"，断言最终的 JSON 信封内容正确，而不只是编译通过。

### MoonBit 侧踩到的坑（`WebAssembly.instantiate` 的第三个参数）

实测中，光靠 `use-js-builtin-string: true` 编译出来的模块，直接 `WebAssembly.instantiate(wasm, imports)` 会报错缺导入。需要额外传编译期选项（这是 V8 对 [JS String Builtins 提案](https://github.com/WebAssembly/js-string-builtins) 的实现方式，不是 import 对象里能提供的东西）：

```js
await WebAssembly.instantiate(wasm, imports, {
  importedStringConstants: "_", // MoonBit 内嵌字符串常量的合成导入模块名
  builtins: ["js-string"],      // 接入 "wasm:js-string" 内建函数（length/concat/...）
});
```

## 尚未验证 / 不建议直接照搬进生产的地方

- 这两个 demo 都是本地 `rustc`/`moon` 直接编译单文件跑通，跟 `src/compiler.ts` 里实际的编译管线（临时目录、`moon.mod.json`/`moon.pkg.json`、`compileWasm()`）没有打通。
- 如果要把 MoonBit 路径接入生产：
  - `compileWasm()` 里 MoonBit 分支的 `moon build --target wasm` 需要改成 `--target wasm-gc`，`moon.pkg.json` 需要加 `use-js-builtin-string: true`；
  - `src/wasm-bridge.ts` 的 `buildWasmImports`/`readWasmStr` 是为 Rust 的裸指针 ABI 写的，MoonBit 需要一套单独的桥接函数（导入导出都是普通 `String`，不需要 `memory`/`alloc`）；
  - `executor.ts` 需要按 `version.language` 区分调用哪套桥接。
- 没有验证过 Rust 的 no_std 手写 JSON 转义在极端输入（控制字符、非 ASCII）下是否完全正确——demo 里只覆盖了 `"`/`\` 转义，生产如果要用这个模式需要补全。
