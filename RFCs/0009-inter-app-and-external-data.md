# RFC 0009：小程序互联与外部数据源接入

- 状态：Proposed
- 日期：2026-08-10

## 1. 目的

定义 Hosta 小程序之间互相调用以及接入外部数据源的能力，使小程序能够组合成更大的服务网络。

## 2. 小程序互联（Inter-App Calling）

### 2.1 设计目标

- 程序 A 可以调用程序 B 的已发布版本
- 调用是 HTTP 级别的，不依赖共享内存
- 平台自动处理认证和服务发现
- 调用链路可追踪

### 2.2 API 设计

**ctx.call 接口**：

```javascript
async function main(input, ctx) {
  // 调用另一个已发布的程序
  const result = await ctx.call("order-summary", { items: input.items });
  // result 是目标程序的返回值
  ctx.log("info", "Called order-summary", { result });
  return { summary: result, enriched: true };
}
```

**ctx.call 签名**：

```typescript
ctx.call(appCode: string, input: object, options?: {
  timeout?: number;     // 默认 3000ms
  version?: string;     // 默认使用目标程序的线上版本
}): Promise<any>
```

### 2.3 实现方式

**方案一：平台内部代理（推荐）**

控制面直接调用目标程序的 `execute()` 函数，跳过 HTTP 层：

```javascript
// server.mjs 中的 ctx.call 实现
ctx.call = async (appCode, input, options = {}) => {
  const target = appByCode(appCode);
  if (!target) throw new Error(`App not found: ${appCode}`);
  const deployment = store.deployments.find(
    (d) => d.appId === target.id && d.status === "active",
  );
  if (!deployment) throw new Error(`App not published: ${appCode}`);
  const version = versionById(deployment.versionId);
  const run = await execute(version, input, "inter_app_call");
  if (run.status !== "succeeded")
    throw new Error(run.error?.message || "Inter-app call failed");
  return run.result;
};
```

**方案二：HTTP 回调**

程序通过 HTTP 调用 `/invoke/:appCode`，但需要注入内部密钥。

**推荐方案一**：性能更好，不经过网络栈，且不需要管理内部密钥。

### 2.4 安全约束

- 仅允许调用已发布（`status === 'active'`）的程序
- 调用计入目标程序的运行记录
- 递归调用深度限制（默认 3 层）
- 总调用超时限制（默认 10 秒）
- 调用链路在运行记录中可追踪（`parentRunId`）

### 2.5 运行记录追踪

```json
{
  "id": "run_xxx",
  "appId": "app_a",
  "trigger": "inter_app_call",
  "parentRunId": "run_yyy",
  "calledAppId": "app_b",
  "status": "succeeded",
  ...
}
```

## 3. 外部数据源接入

### 3.1 设计目标

- 程序可以访问外部 HTTP API
- 平台控制可访问的域名和协议
- 请求大小和超时可配置
- 外部调用可审计

### 3.2 API 设计

**ctx.fetch 接口**：

```javascript
async function main(input, ctx) {
  // 调用外部 API（需要在程序中启用网络能力）
  const response = await ctx.fetch("https://api.example.com/data", {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  const data = await response.json();
  return { external: data, processed: true };
}
```

**ctx.fetch 签名**：

```typescript
ctx.fetch(url: string, options?: {
  method?: string;       // GET, POST, PUT, DELETE
  headers?: object;      // 请求头
  body?: string;         // 请求体
  timeout?: number;      // 默认 5000ms
}): Promise<{
  status: number;
  headers: object;
  json(): Promise<any>;
  text(): Promise<string>;
}>
```

### 3.3 网络能力配置

**程序级别的网络能力声明**：

```json
{
  "appId": "app_xxx",
  "capabilities": {
    "network": {
      "enabled": true,
      "allowedDomains": ["api.example.com", "*.github.com"],
      "allowedProtocols": ["https"],
      "allowedPorts": [443],
      "maxResponseBytes": 1048576,
      "timeoutMs": 5000
    }
  }
}
```

**安全约束**：

- 默认禁用网络访问
- 仅允许 HTTPS（除非明确配置）
- 域名白名单机制
- DNS 解析在服务端进行
- 禁止访问内网地址（10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8）
- 禁止访问 metadata 服务（169.254.169.254）
- 禁止访问 localhost

### 3.4 外部数据源作为数据源

**概念**：除了 JSON 静态数据源，程序还可以绑定外部 HTTP 数据源

```json
{
  "id": "eds_xxx",
  "appId": "app_xxx",
  "type": "http",
  "config": {
    "url": "https://api.example.com/data",
    "method": "GET",
    "headers": { "Authorization": "Bearer {{secret:api_key}}" },
    "refreshInterval": 3600
  }
}
```

**使用方式**：

```javascript
async function main(input, ctx) {
  const externalData = await ctx.datasource("external");
  // externalData 是外部数据源的缓存结果
  return { combined: { local: input, external: externalData } };
}
```

## 4. 服务发现与目录

### 4.1 当前实现

`GET /api/discover` 返回所有已发布程序的调用文档。

### 4.2 增强方向

- 按能力分类（数据转换、API 封装、定时任务等）
- 按标签过滤
- 输入输出 schema 展示
- 调用示例自动生成
- 使用量统计（热门程序）

### 4.3 增强后的 discover 响应

```json
{
  "published": [
    {
      "code": "order-summary",
      "name": "订单汇总",
      "description": "按币种汇总有效订单金额",
      "runtime": "javascript",
      "capabilities": [],
      "inputSchema": { "items": "array" },
      "outputSchema": { "total": "number", "count": "number" },
      "invokeUrl": "https://hosta.example.com/invoke/order-summary",
      "callCount": 42,
      "callExample": "ctx.call('order-summary', { items: [...] })"
    }
  ],
  "count": 1
}
```

## 5. 调用链追踪

### 5.1 运行记录关联

当程序 A 调用程序 B 时，B 的运行记录中：

- `trigger`: `"inter_app_call"`
- `parentRunId`: A 的运行记录 ID
- `callerAppId`: A 的 ID

### 5.2 可视化调用链

```text
run_001 (manual)
  ├── run_002 (inter_app_call → order-summary)
  │   └── run_003 (inter_app_call → currency-convert)
  └── run_004 (inter_app_call → notification)
```

## 6. 实现优先级

### 本次实现（Phase 1）

- [x] 基本数据源（JSON 静态数据）
- [x] 数据源快照和迁移
- [x] `/api/discover` 基本服务发现（含 schema/capabilities/callExample）
- [x] `/llms.txt` LLM Agent 指南
- [x] 小程序间调用（`ctx.call`，深度限制 3）
- [x] 调用链追踪（`parentRunId` / `callerAppId` / `callDepth`）

### 后续实现（Phase 2+）

- [ ] 外部 HTTP 数据源（`ctx.fetch`）
- [ ] 网络能力配置
- [ ] 外部数据源缓存
- [ ] 调用链可视化
- [ ] 公开程序目录增强
- [ ] 使用量统计

## 7. 与现有实现的映射

| 功能       | 当前状态                                   | 需要完善           |
| ---------- | ------------------------------------------ | ------------------ |
| 数据源     | ✅ JSON 静态数据                           | 扩展为外部数据源   |
| 数据快照   | ✅ 自动快照                                | -                  |
| 数据迁移   | ✅ JS 迁移脚本                             | -                  |
| 服务发现   | ✅ `/api/discover` 含 schema/capabilities  | 增加能力注册表     |
| LLM 指南   | ✅ `/llms.txt`                             | 增加 ctx.call 文档 |
| 程序间调用 | ✅ `ctx.call()` 深度限制 3                 | 增加递归限制可视化 |
| 外部网络   | ❌ 未实现                                  | 新增 ctx.fetch     |
| 调用链追踪 | ✅ `parentRunId`/`callerAppId`/`callDepth` | 增加可视化         |
