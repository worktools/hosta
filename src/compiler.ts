import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CompileResult, FormatResult } from "./types.js";

// ── 子进程运行 ────────────────────────────────────────────────────────────────

function runCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<string> {
  return new Promise<string>((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const finish = (callback: (value: any) => void, value: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(
        rejectRun,
        new Error(`${command} exceeded the 15 second compilation limit`),
      );
    }, 15000);
    child.on("error", (err) => finish(rejectRun, err));
    child.on("close", (code) =>
      finish(
        code === 0 ? resolveRun : rejectRun,
        code === 0
          ? output
          : new Error(output.slice(-6000) || `${command} exited with ${code}`),
      ),
    );
  });
}

// ── WASM 编译 ─────────────────────────────────────────────────────────────────

export async function compileWasm(
  language: string,
  source: string,
): Promise<CompileResult> {
  if (process.env.HOSTA_ENABLE_LOCAL_COMPILER !== "1") {
    const err = new Error("Upload precompiled WASM with encoding=base64; trusted local source compilation requires HOSTA_ENABLE_LOCAL_COMPILER=1");
    Object.assign(err,{status:400}); throw err;
  }
  const workdir = await mkdtemp(join(tmpdir(), "hosta-compile-"));
  try {
    let outputFile: string;
    if (language === "moonbit") {
      await writeFile(
        join(workdir, "moon.mod.json"),
        JSON.stringify({ name: "hosta/runner", version: "0.1.0" }),
      );
      await writeFile(
        join(workdir, "moon.pkg.json"),
        JSON.stringify({
          name: "hosta/runner",
          link: { wasm: { exports: ["run:main"] } },
        }),
      );
      await writeFile(join(workdir, "main.mbt"), source);
      await runCommand(
        "moon",
        ["build", "--target", "wasm", "--release"],
        workdir,
      );
      outputFile = join(workdir, "_build/wasm/release/build/runner.wasm");
    } else {
      outputFile = join(workdir, "module.wasm");
      await writeFile(join(workdir, "main.rs"), source);
      await runCommand(
        "rustc",
        [
          "+stable",
          "--target",
          "wasm32-unknown-unknown",
          "-O",
          "--crate-type",
          "cdylib",
          "main.rs",
          "-o",
          "module.wasm",
        ],
        workdir,
      );
    }
    const wasm = await readFile(outputFile);

    return { binary: wasm.toString("base64"), size: wasm.length };
  } catch (error: any) {
    const wrapped = new Error(
      `Compilation failed: ${String(error.message).slice(0, 6000)}`,
    ) as Error & { status: number };
    wrapped.status = 400;
    throw wrapped;
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

// ── 代码格式化 ─────────────────────────────────────────────────────────────────

export async function formatCode({
  code,
  runtime,
  language,
}: {
  code: string;
  runtime: string;
  language: string;
}): Promise<FormatResult> {
  if (!code) return { formatted: code, formatter: null };
  const workdir = await mkdtemp(join(tmpdir(), "hosta-format-"));
  try {
    let fileName: string, formatter: string, args: string[];
    const root = process.cwd();
    if (runtime === "wasm" && language === "moonbit") {
      fileName = "main.mbt";
      formatter = "moonfmt";
      args = ["-w", fileName];
    } else if (runtime === "wasm" && language === "rust") {
      fileName = "main.rs";
      formatter = "rustfmt";
      args = [fileName];
    } else {
      fileName = "index.js";
      formatter = join(root, "node_modules", ".bin", "prettier");
      args = ["--write", fileName];
    }
    await writeFile(join(workdir, fileName), code);
    await runCommand(formatter, args, workdir);
    const formatted = await readFile(join(workdir, fileName), "utf8");
    return { formatted, formatter: fileName };
  } catch (error: any) {
    const wrapped = new Error(
      `Formatting failed: ${String(error.message).slice(0, 6000)}`,
    ) as Error & { status: number };
    wrapped.status = 400;
    throw wrapped;
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}
