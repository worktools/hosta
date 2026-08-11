# Hosta

Hosta 是一个本地优先的 AI 软件工厂 MVP：从自然语言需求生成一个 JavaScript 自动化，先试运行，再发布为可鉴权的 Webhook。

界面改进和新功能开发遵循 [视觉与交互规范](VISUAL_INTERACTION_GUIDELINES.md)。

## 启动

需要 Node.js 22+：

```bash
cp .env.example .env # 可选，填写 DeepSeek 配置
npm ci
npm run build
npm start
```

构建输出位于本地 `dist/`，由 Git 忽略；不要提交其中的文件。生产服务会从该目录提供静态页面。

打开 http://127.0.0.1:4173。未配置 `DEEPSEEK_API_KEY` 时，页面会明确显示“本地演示生成器”，便于验证完整创建/运行/发布流程；配置后会调用 DeepSeek 的 Chat Completions 兼容接口。

数据保存在 `data/hosta.json`。发布时页面只显示一次 Webhook Bearer key，服务端只保存其 SHA-256 hash。

## 当前安全边界

这是单用户、本地预览 MVP。JavaScript 执行使用 Node `vm.createContext` 沙箱，WASM 执行使用 Node.js 内置 `WebAssembly` API + JSPI（`--experimental-wasm-jspi`）。两者均拒绝常见宿主 API 和网络访问；这不是面向不可信公网代码的充分安全边界。生产化应考虑容器/进程级隔离、资源限制与网络策略。

## 主流程

创建应用 → 生成版本 → 页面试运行成功 → 发布 → 携带 Bearer key 调用 Webhook，或创建 60 秒以上的持久化定时任务 → 页面查看运行记录。

在应用的“编辑、运行、发布与定时触发”面板中，代码编辑会创建不可变的新版本；不会覆盖已发布的版本。诊断会先给出策略、语法和可观测性提示，再以示例输入执行，展示结构化日志、返回值、错误和耗时。

每次生成会保存模型提供方、模型名和 token 用量（若提供方返回）；价格不在代码中硬编码，以避免因模型价格变化产生误导性成本数字。
