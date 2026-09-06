import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type { Store } from "./types.js";
import { dataFile, now } from "./config.js";

// ── 数据持久化 ────────────────────────────────────────────────────────────────

/** 从 JSON 文件加载 store */
async function loadStore(): Promise<Store> {
  try {
    return JSON.parse(await readFile(dataFile, "utf8"));
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
    return {
      apps: [],
      versions: [],
      deployments: [],
      runs: [],
      schedules: [],
      modelCalls: [],
      datasources: [],
      datasourceSnapshots: [],
      externalDatasources: [],
      pages: [],
    };
  }
}

/** 初始化 store */
export let store: Store = await loadStore();

// 初始化可能缺失的数组
store.schedules ??= [];
store.modelCalls ??= [];
store.datasources ??= [];
store.datasourceSnapshots ??= [];
store.externalDatasources ??= [];
store.pages ??= [];

/** 序列化写入：保证并发 save() 调用按顺序执行 */
let serial = Promise.resolve();
export function save(): Promise<void> {
  serial = serial.catch(() => {}).then(async () => {
    await mkdir(dirname(dataFile), { recursive: true });
    await writeFile(`${dataFile}.tmp`, JSON.stringify(store, null, 2));
    await rename(`${dataFile}.tmp`, dataFile);
  });
  return serial;
}

// ── 迁移兼容层 ────────────────────────────────────────────────────────────────

let migratedAppCodes = false;
let nextSerial = 1;
for (const app of store.apps) {
  if (typeof app.serial === "number")
    nextSerial = Math.max(nextSerial, app.serial + 1);
}
for (const app of store.apps) {
  (app as any).runtime ??= "javascript";
  if (typeof app.serial !== "number") {
    let slug = String(app.code || "").trim();
    if (/^\d+-/.test(slug)) slug = slug.replace(/^\d+-/, "");
    else if (/^fn-/.test(slug)) slug = slug.replace(/^fn-/, "");
    app.serial = nextSerial++;
    app.code = `${app.serial}-${
      slug
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 36) || "app"
    }`;
    migratedAppCodes = true;
  }
}
if (migratedAppCodes) await save();

export { nextSerial };

/** 消费并递增序列号 */
export function consumeSerial(): number {
  return nextSerial++;
}
