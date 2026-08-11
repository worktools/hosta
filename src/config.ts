import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** 项目根目录 */
export const root = resolve(__dirname, "..");

/** 前端静态资源目录 */
export const staticDir = join(root, "dist");

/** 数据文件路径 */
export const dataFile = join(root, "data", "hosta.json");

/** 服务器端口 */
export const port = Number(process.env.PORT) || 4173;

/** 当前时间戳（ISO 格式） */
export function now(): string {
  return new Date().toISOString();
}
