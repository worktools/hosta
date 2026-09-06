# Hosta

Hosta 是一个面向开发者和 agents 的轻量 serverless 平台原型。CLI/API 完成创建、上传版本、试运行、发布和诊断；网页先只读展示应用、版本、运行和引擎状态。AI 是可选增强。

执行由独立维护的 [Hoya](https://github.com/worktools/hoya) 提供，支持 QuickJS 和 Rust WASM 的 JSON 输入输出。本分支需要 Hoya execution v1，旧版 Hoya 不兼容；Hosta 不回退到 Node vm 或 Node WASM 执行。

## 启动与首次调用

需要 Node.js 22+，以及支持 `/v1/executions` 和 `hoya-json-v1` 的 Hoya 二进制。先按 Hoya 的 `docs/engine-v1.md` 启动引擎，再启动 Hosta：

```sh
npm ci
npm run build
export HOYA_URL=http://127.0.0.1:3000
export HOYA_AUTH_TOKEN=local-example # 必须与 Hoya 一致
npm start
```

另开终端：

```sh
node bin/hosta.mjs doctor --json
node bin/hosta.mjs apps create --name echo --json
node bin/hosta.mjs --help
```

[CLI 指南](docs/CLI.md) 包含 JS/Rust WASM 的上传、运行、发布、调用、查询日志完整命令，以及退出码、幂等和错误恢复约定。可选 `npm link` 安装 `hosta` 命令。浏览器打开 http://127.0.0.1:4173 查看状态，无需网页操作完成验收。

## 配置与边界

- `HOYA_URL` / `HOYA_AUTH_TOKEN`：独立引擎连接与凭据。
- `HOSTA_API_TOKEN`：可选管理 API 鉴权；CLI 使用同名变量。启用后，当前只读网页不提供凭据输入，使用 CLI 查询。
- `HOSTA_DATA_FILE`：默认 `data/hosta.json`；本地原型仍使用单进程 JSON 存储。
- `HOSTA_WEBHOOK_KEY`：CLI 调用已发布程序的独立密钥，首次发布时返回。再次发布不轮换它。
- `DEEPSEEK_API_KEY`：仅可选 JS 生成使用；无 key 时可从源码/模板上传。
- WASM 使用预编译产物上传，导出 `memory` 和 `hoya_main() -> i32`。旧整数 `main` 模板需重建。MoonBit ABI 尚未验证。
- `HOSTA_ENABLE_LOCAL_COMPILER=1` 仅开启受信本地源码编译；隔离构建尚未完成。

当前是单用户本地预览：Hoya v1 默认禁网且每次执行使用独立进程；容器/OS 资源治理、受控网络、多租户安全评审与事务存储仍在后续 issues。不要将原型当作已完成加固的公网多租户服务。许可证仍待维护者选定。

## 验证

```sh
npm test
npm run build
HOYA_BINARY=/absolute/path/to/hoya/target/debug/hoya npm run test:smoke
```

`npm test` 包含真实 CLI 子进程和 API fixture；只有提供 `HOYA_BINARY` 才执行双运行时 smoke。Smoke 自动启动临时 Hosta/Hoya、使用独立数据、编译 Rust WASM，并检查发布调用、死循环超时恢复和引擎离线。WASM 测试需 Rust stable 的 `wasm32-unknown-unknown` target。

开发事项见 [Hosta issues](https://github.com/worktools/hosta/issues) 和 [Hoya issues](https://github.com/worktools/hoya/issues)。构建产物 `dist/` 不提交。
