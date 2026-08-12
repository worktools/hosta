/**
 * hoya-client.ts — HTTP 桥接层，连接 Hosta 与 hoya 沙箱执行引擎
 *
 * 架构：
 *   Hosta (Node.js) ──HTTP──→ hoya (Rust, QuickJS + Wasmtime)
 *
 * 设计原则：
 * - hoya 进程由 Node.js 作为子进程管理（spawn），通信走 HTTP
 * - 启动时自动拉起 hoya 二进制，关闭时自动 kill
 * - 所有执行请求通过 POST /execute/js 和 POST /execute/wasm 发送
 * - 超时由 hoya 侧燃料/内存限制 + Node.js 侧 HTTP 超时双重保障
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";

// ── 配置 ──────────────────────────────────────────────────────────────────────

export interface HoyaClientOptions {
  /** hoya 二进制路径（默认在 PATH 中查找 "hoya"） */
  binaryPath?: string;
  /** hoya 服务端口（默认 4300，不与 Hosta 的 4173 冲突） */
  port?: number;
  /** 是否自动管理 hoya 子进程生命周期 */
  autoManage?: boolean;
  /** 请求超时（毫秒，默认 10s） */
  timeoutMs?: number;
}

const DEFAULT_OPTIONS: Required<HoyaClientOptions> = {
  binaryPath: "hoya",
  port: 4300,
  autoManage: true,
  timeoutMs: 10_000,
};

// ── 类型 ──────────────────────────────────────────────────────────────────────

export interface HoyaExecuteResponse {
  status: string;
  output: string | null;
  stdout: string | null;
  stderr: string | null;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  } | null;
  metadata: {
    execution_time: number;
    code_type: string;
    timestamp: string;
    resource_size: number;
  };
}

export interface JsExecuteRequest {
  code: string;
  input?: Record<string, unknown>;
  datasource?: Record<string, unknown>;
}

export interface WasmExecuteRequest {
  code: string; // base64 编码的 WASM 二进制
  input_json?: string;
  datasource_json?: string;
}

// ── 进程管理 ──────────────────────────────────────────────────────────────────

let hoyaProcess: ChildProcess | null = null;
let hoyaOptions: Required<HoyaClientOptions> = DEFAULT_OPTIONS;
let hoyaReady = false;
/** 每次启动随机生成的共享密钥，通过环境变量传给 hoya 子进程，仅同一台机器上的调用者可用 */
let hoyaAuthToken: string | null = null;
/** stopHoya() 设置此标记，区分主动停止与意外崩溩，避免主动停止时触发自动重启 */
let intentionalStop = false;
/** 连续意外崩溩次数，超过上限就放弃重启，避免 crash loop */
let restartAttempts = 0;
const MAX_RESTART_ATTEMPTS = 5;

/**
 * 启动 hoya 子进程，等待其就绪。
 */
export async function startHoya(
  options: HoyaClientOptions = {},
): Promise<void> {
  hoyaOptions = { ...DEFAULT_OPTIONS, ...options };

  if (hoyaProcess) {
    console.warn("[hoya-client] hoya process already running");
    return;
  }

  const env = {
    ...process.env,
    PORT: String(hoyaOptions.port),
    HOYA_AUTH_TOKEN: hoyaAuthToken ?? (hoyaAuthToken = randomBytes(24).toString("hex")),
  };

  console.log(`[hoya-client] Starting hoya on port ${hoyaOptions.port}...`);

  hoyaProcess = spawn(hoyaOptions.binaryPath, [], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  hoyaProcess.stdout?.on("data", (data: Buffer) => {
    for (const line of data.toString().trim().split("\n")) {
      console.log(`[hoya] ${line}`);
    }
  });

  hoyaProcess.stderr?.on("data", (data: Buffer) => {
    for (const line of data.toString().trim().split("\n")) {
      console.error(`[hoya:err] ${line}`);
    }
  });

  hoyaProcess.on("exit", (code, signal) => {
    console.log(`[hoya-client] hoya exited (code=${code}, signal=${signal})`);
    hoyaProcess = null;
    hoyaReady = false;
    if (intentionalStop) {
      intentionalStop = false;
      return;
    }
    console.error("[hoya-client] hoya exited unexpectedly, scheduling restart...");
    scheduleRestart();
  });

  hoyaProcess.on("error", (err) => {
    console.error(`[hoya-client] hoya process error:`, err.message);
    hoyaProcess = null;
    hoyaReady = false;
  });

  // 等待 hoya 服务就绪（轮询 health endpoint）
  await waitForReady(5_000);
  hoyaReady = true;
  restartAttempts = 0;
  console.log("[hoya-client] hoya is ready");
}

/**
 * hoya 意外退出后按指数退避自动重启，达到次数上限后放弃。
 */
function scheduleRestart(): void {
  if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
    console.error(
      `[hoya-client] hoya crashed ${restartAttempts} times in a row, giving up automatic restart`,
    );
    return;
  }
  restartAttempts += 1;
  const delayMs = Math.min(1000 * 2 ** restartAttempts, 30_000);
  console.log(`[hoya-client] restarting hoya in ${delayMs}ms (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS})`);
  setTimeout(() => {
    startHoya(hoyaOptions).catch((err) => {
      console.error("[hoya-client] restart attempt failed:", err);
    });
  }, delayMs);
}

/**
 * 停止 hoya 子进程。
 */
export async function stopHoya(): Promise<void> {
  if (!hoyaProcess) return;
  intentionalStop = true;
  hoyaProcess.kill("SIGTERM");
  // 等待最多 3 秒优雅退出
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      hoyaProcess?.kill("SIGKILL");
      resolve();
    }, 3000);
    hoyaProcess?.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  hoyaProcess = null;
  hoyaReady = false;
  console.log("[hoya-client] hoya stopped");
}

/**
 * 检查 hoya 是否运行中。
 */
export function isHoyaRunning(): boolean {
  return hoyaProcess !== null && hoyaReady;
}

// ── HTTP 请求 ─────────────────────────────────────────────────────────────────

/**
 * 向 hoya 发送 HTTP 请求。
 */
function hoyaRequest(
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<HoyaExecuteResponse> {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: "127.0.0.1",
      port: hoyaOptions.port,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
        ...(hoyaAuthToken ? { Authorization: `Bearer ${hoyaAuthToken}` } : {}),
      },
    };

    const req = httpRequest(options, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed as HoyaExecuteResponse);
        } catch {
          reject(new Error(`hoya response parse error: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on("error", (err) => {
      reject(new Error(`hoya request failed: ${err.message}`));
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`hoya request timed out after ${timeoutMs}ms`));
    });

    req.write(bodyStr);
    req.end();
  });
}

// ── 公开 API ──────────────────────────────────────────────────────────────────

/**
 * 在 hoya 沙箱中执行 JavaScript 代码。
 *
 * 与 Hosta 的 `main(input, ctx)` 约定兼容：
 * - 代码必须定义 `async function main(input, ctx)`
 * - `ctx.log(level, message, fields?)` 用于结构化日志
 * - `ctx.datasource` 包含数据源
 * - `ctx.now()` 返回当前时间戳
 */
export async function executeJs(
  request: JsExecuteRequest,
  timeoutMs?: number,
): Promise<HoyaExecuteResponse> {
  if (!hoyaReady) {
    throw new Error("hoya not ready; call startHoya() first");
  }
  return hoyaRequest(
    "/execute/js",
    {
      code: request.code,
      input: request.input ?? null,
      datasource: request.datasource ?? null,
    },
    timeoutMs ?? hoyaOptions.timeoutMs,
  );
}

/**
 * 在 hoya 沙箱中执行 WebAssembly 代码。
 *
 * @param code base64 编码的 WASM 二进制
 * @param inputJson 可选的输入 JSON 字符串
 */
export async function executeWasm(
  request: WasmExecuteRequest,
  timeoutMs?: number,
): Promise<HoyaExecuteResponse> {
  if (!hoyaReady) {
    throw new Error("hoya not ready; call startHoya() first");
  }
  return hoyaRequest(
    "/execute/wasm",
    {
      code: request.code,
      input_json: request.input_json ?? null,
      datasource_json: request.datasource_json ?? null,
    },
    timeoutMs ?? hoyaOptions.timeoutMs,
  );
}

// ── 启动检测 ──────────────────────────────────────────────────────────────────

/**
 * 轮询 health endpoint 直到服务就绪。
 */
async function waitForReady(maxWaitMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${hoyaOptions.port}/health`,
      );
      if (response.ok) return;
    } catch {
      // 服务尚未就绪，继续等待
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`hoya failed to become ready within ${maxWaitMs}ms`);
}
