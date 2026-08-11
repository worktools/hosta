import type { WasmEnvelope } from "./types.js";

// ── WASM 内存桥 ──────────────────────────────────────────────────────────────

export interface WasmImports {
  imports: {
    env: {
      fetch: any; // WebAssembly.Suspending — JSPI type not in TS lib
      log: (ptr: number, len: number) => void;
      now: () => bigint;
      get_input: (ptr: number, maxLen: number) => number;
      get_datasource: (ptr: number, maxLen: number) => number;
    };
  };
  bind: (mem: WebAssembly.Memory, alloc: (size: number) => number) => void;
}

/**
 * 构建 WASM 导入对象（带 JSPI 包装）
 */
export function buildWasmImports(
  logs: Array<{ level: string; message: string; at: string }>,
  input: Record<string, unknown>,
  ds: { data: Record<string, unknown> } | undefined,
): WasmImports {
  let memory: WebAssembly.Memory;
  let alloc: (size: number) => number;

  function readStr(ptr: number, len: number): string {
    return new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len));
  }

  function writeStr(str: string): number {
    const encoded = new TextEncoder().encode(str);
    const ptr = alloc(encoded.length + 1);
    const buf = new Uint8Array(memory.buffer, ptr, encoded.length + 1);
    buf.set(encoded, 0);
    buf[encoded.length] = 0; // null terminator
    return ptr;
  }

  return {
    imports: {
      env: {
        fetch: new (WebAssembly as any).Suspending(
          async (urlPtr: number, urlLen: number) => {
            const url = readStr(urlPtr, urlLen);
            try {
              const parsed = new URL(url);
              if (!["http:", "https:"].includes(parsed.protocol))
                return writeStr(
                  JSON.stringify({
                    ok: false,
                    error: {
                      code: "INVALID_URL",
                      message: "only http/https URLs allowed",
                    },
                  }),
                );
              const blocked = ["127.0.0.1", "localhost", "::1", "0.0.0.0"];
              if (blocked.includes(parsed.hostname))
                return writeStr(
                  JSON.stringify({
                    ok: false,
                    error: {
                      code: "BLOCKED_HOST",
                      message: "cannot access localhost",
                    },
                  }),
                );
              const resp = await fetch(url, {
                method: "GET",
                signal: AbortSignal.timeout(5000),
                redirect: "follow",
              });
              const text = await resp.text();
              if (text.length > 524288)
                return writeStr(
                  JSON.stringify({
                    ok: false,
                    error: {
                      code: "RESPONSE_TOO_LARGE",
                      message: "response exceeds 512KB limit",
                    },
                  }),
                );
              return writeStr(JSON.stringify({ ok: true, data: text }));
            } catch (err: any) {
              return writeStr(
                JSON.stringify({
                  ok: false,
                  error: {
                    code: "FETCH_ERROR",
                    message: String(err.message).slice(0, 2000),
                  },
                }),
              );
            }
          },
        ),
        log: (ptr: number, len: number) => {
          if (logs.length < 100) {
            const msg = readStr(ptr, len);
            logs.push({
              level: "info",
              message: msg.slice(0, 2000),
              at: new Date().toISOString(),
            });
          }
        },
        now: () => BigInt(Date.now()),
        get_input: (ptr: number, maxLen: number) => {
          const json = JSON.stringify(input ?? {});
          const encoded = new TextEncoder().encode(json);
          const len = Math.min(encoded.length, maxLen);
          new Uint8Array(memory.buffer).set(encoded.subarray(0, len), ptr);
          return len;
        },
        get_datasource: (ptr: number, maxLen: number) => {
          const json = JSON.stringify(
            ds ? JSON.parse(JSON.stringify(ds.data)) : {},
          );
          const encoded = new TextEncoder().encode(json);
          const len = Math.min(encoded.length, maxLen);
          new Uint8Array(memory.buffer).set(encoded.subarray(0, len), ptr);
          return len;
        },
      },
    },
    bind(mem: WebAssembly.Memory, al: (size: number) => number) {
      memory = mem;
      alloc = al;
    },
  };
}

/** 读取 WASM 内存中的空终止字符串 */
export function readWasmStr(memory: WebAssembly.Memory, ptr: number): string {
  const buf = new Uint8Array(memory.buffer, ptr);
  let end = 0;
  while (end < buf.length && buf[end] !== 0) end++;
  return new TextDecoder().decode(buf.subarray(0, end));
}

/** 解析 WASM 信封协议 */
export function parseWasmEnvelope(str: string): WasmEnvelope {
  try {
    return JSON.parse(str);
  } catch {
    return {
      ok: false,
      error: { code: "INVALID_RESULT", message: "WASM returned invalid JSON" },
    };
  }
}
