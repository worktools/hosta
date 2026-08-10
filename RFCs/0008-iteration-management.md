# RFC 0008：全生命周期迭代管理

- 状态：Proposed
- 日期：2026-08-10

## 1. 目的

定义 Hosta 小程序的完整生命周期管理，覆盖从创建到废弃的所有阶段，以及每个阶段的状态转换、触发条件和操作权限。

## 2. 程序生命周期状态机

```text
                    ┌─────────────┐
                    │   created   │  ← 创建应用
                    └──────┬──────┘
                           │ POST /api/apps/:id/generate
                           ▼
                    ┌─────────────┐
                    │ generating  │  ← LLM 生成中
                    └──────┬──────┘
                           │ 生成完成
                           ▼
                    ┌─────────────┐
              ┌─────│    draft    │  ← 草稿状态（当前编辑版本）
              │     └──────┬──────┘
              │            │ 保存/编辑
              │            ▼
              │     ┌─────────────┐
              │     │ needs_rev   │  ← 需要修订（校验失败）
              │     └──────┬──────┘
              │            │ 修复后保存
              │            ▼
              │     ┌─────────────┐
              │     │    ready    │  ← 就绪（校验通过，可试运行）
              │     └──────┬──────┘
              │            │ 设为默认版本
              │            ▼
              │     ┌─────────────┐
              │     │  published  │  ← 已发布（线上版本）
              │     └──────┬──────┘
              │            │ 继续编辑 → 回到 draft
              │            │ 停用
              │            ▼
              │     ┌─────────────┐
              └─────│  disabled   │  ← 已停用
                    └─────────────┘
```

### 2.1 状态说明

| 状态             | 说明               | 可执行操作                     |
| ---------------- | ------------------ | ------------------------------ |
| `created`        | 应用已创建，无版本 | 生成、编辑                     |
| `generating`     | LLM 正在生成代码   | 等待                           |
| `draft`          | 草稿版本           | 编辑代码、运行、诊断、测试     |
| `needs_revision` | 校验失败，需要修订 | 修复代码、请求 LLM 修订        |
| `ready`          | 校验通过，可试运行 | 运行、诊断、测试、设为默认版本 |
| `published`      | 已设为线上版本     | 调用、查看日志、切换版本       |
| `disabled`       | 已停用             | 重新启用、删除                 |

## 3. 版本管理

### 3.1 版本不可变性

每个版本创建后，其代码（`code`）、哈希（`codeSha256`）、测试用例（`tests`）不可修改。这是保证发布安全的核心原则。

**修改操作**：

- 编辑代码 → 创建新版本
- 修改测试 → 追加到当前版本
- 变更数据源 → 不影响版本

### 3.2 版本指针

每个应用维护两个指针：

- `draftVersionId`：当前编辑的版本
- `publishedVersionId`：线上版本

`draftVersionId` 随编辑/生成而变化，`publishedVersionId` 仅通过"设为默认版本"操作变更。

### 3.3 版本回滚

回滚本质上是将 `publishedVersionId` 切换到一个历史 `ready` 版本。

**操作**：在版本列表中点击历史版本的"设为默认版本"按钮。

**安全约束**：

- 目标版本必须是 `ready` 状态
- 会自动创建新的 deployment 记录（或更新现有 deployment 的 versionId）

## 4. 测试框架

### 4.1 测试用例结构

```json
{
  "name": "空数组输入",
  "input": { "items": [] },
  "expectedOutput": { "total": 0, "count": 0 }
}
```

- `name`：测试名称（必填，≤200字符）
- `input`：测试输入（必填，JSON 对象）
- `expectedOutput`：期望输出（可选，JSON 对象）

### 4.2 测试运行

- **单次运行**：`POST /api/versions/:id/run` body: `test.input`
- **批量运行**：`POST /api/versions/:id/tests/run-all`
- **自动运行**：生成版本后自动运行所有测试

### 4.3 测试结果

```json
{
  "versionId": "ver_xxx",
  "passed": 2,
  "total": 3,
  "results": [
    {
      "name": "空数组输入",
      "input": { "items": [] },
      "expectedOutput": { "total": 0, "count": 0 },
      "actualStatus": "succeeded",
      "matched": true,
      "runId": "run_xxx",
      "durationMs": 12,
      "result": { "total": 0, "count": 0 }
    }
  ]
}
```

### 4.4 测试生成策略

LLM 生成测试时遵循：

- 至少 1 个正常用例（happy path）
- 至少 1 个边界用例（空输入、null、极值）
- 至少 1 个异常用例（可选，取决于需求）

## 5. 数据源管理

### 5.1 数据源生命周期

```text
┌──────────┐   保存数据    ┌──────────┐
│ 无数据源  │ ──────────→ │ 有数据源  │
└──────────┘              └────┬─────┘
                               │
                    ┌──────────┼──────────┐
                    │ 编辑数据  │ 运行迁移  │ 恢复快照  │
                    ▼          ▼          ▼
               ┌────────┐ ┌────────┐ ┌────────┐
               │ 新快照  │ │待确认   │ │ 回滚    │
               │(自动)   │ │快照    │ │        │
               └────────┘ └───┬────┘ └────────┘
                              │ 手动应用
                              ▼
                         ┌────────┐
                         │ 已应用  │
                         │(新快照  │
                         │ 自动)   │
                         └────────┘
```

### 5.2 快照策略

- 保存数据时自动创建快照
- 执行迁移时创建待确认快照（不自动应用）
- 应用待确认快照时自动创建当前状态的快照
- 最多保留 50 个快照，超出时删除最旧的

### 5.3 迁移脚本

迁移脚本是 JavaScript 代码，在 vm 沙箱中执行：

- 可直接访问 `data` 变量（当前数据源的深拷贝）
- 可直接修改 `data`（如 `data.newField = 'value'`）
- 可使用 `console.log()` 输出日志
- 可用全局对象：`JSON, Math, Number, String, Boolean, Array, Object, Date`
- 5 秒超时限制
- 结果必须是普通对象（非数组、非 null）

## 6. 部署与发布

### 6.1 发布流程

```text
版本 ready → 试运行成功 → 点击"发布" → 生成密钥 → 部署激活
```

**安全约束**：

- 版本必须是 `ready` 状态
- 必须至少一次手动试运行成功（`trigger === 'manual'` 且 `status === 'succeeded'`）
- 密钥仅显示一次，存储 hash
- 发布后 `publishedVersionId` 指向新版本

### 6.2 调用方式

**GET 调用**：

```
GET /invoke/:appCode?key=<KEY>&input={"items":[...]}
GET /invoke/:appCode?key=<KEY>&items=1&items=2
```

**POST 调用**：

```
POST /invoke/:appCode
Authorization: Bearer <KEY>
Content-Type: application/json
{"items": [...]}
```

**Webhook 调用**：

```
POST /hooks/:deploymentId
Authorization: Bearer <KEY>
Content-Type: application/json
{"items": [...]}
```

### 6.3 密钥管理

- 发布时生成 24 字节随机密钥（base64url 编码）
- 数据库仅存储 SHA-256 hash
- 明文仅在发布响应中返回一次
- 后续可添加密钥轮换功能

## 7. 调度任务

### 7.1 定时执行

```json
{
  "id": "sch_xxx",
  "appId": "app_xxx",
  "versionId": "ver_xxx",
  "input": { "items": [] },
  "intervalSeconds": 3600,
  "status": "active",
  "nextRunAt": "2026-08-10T10:00:00.000Z",
  "lastRunAt": null,
  "lastRunId": null
}
```

- 最小间隔：60 秒
- 最大间隔：86400 秒（24 小时）
- 使用 `setTimeout` 实现，进程重启后重新调度
- 调度使用版本的固化代码，不受后续编辑影响

## 8. 运行记录

### 8.1 运行状态

```text
queued → running → succeeded
                 ├→ failed
                 ├→ timed_out
                 ├→ rejected
                 └→ internal_error
```

### 8.2 触发来源

| 触发方式 | trigger 值       | 说明                      |
| -------- | ---------------- | ------------------------- |
| 手动运行 | `manual`         | 用户在 UI 中点击运行      |
| 诊断     | `diagnostic`     | 用户在 UI 中点击诊断      |
| 测试     | `test`           | 自动测试批量运行          |
| 生成测试 | `generated_test` | 版本生成时的自动测试      |
| Webhook  | `webhook`        | 通过 `/hooks/:id` 调用    |
| Invoke   | `invoke`         | 通过 `/invoke/:code` 调用 |
| 定时     | `schedule`       | 定时任务触发              |

## 9. 代码质量门禁

### 9.1 当前校验规则

| 规则               | 严重程度 | 说明                                                   |
| ------------------ | -------- | ------------------------------------------------------ |
| POLICY_REJECTED    | error    | 禁用的 host API（require, process, eval, Function 等） |
| SYNTAX_ERROR       | error    | JavaScript 语法错误                                    |
| NO_STRUCTURED_LOGS | info     | 建议使用 ctx.log                                       |
| NO_EXPLICIT_RETURN | warning  | 缺少显式 return                                        |
| WASM_ISOLATION     | info     | WASM 隔离提示                                          |

### 9.2 建议新增规则

| 规则              | 严重程度 | 说明               |
| ----------------- | -------- | ------------------ |
| CODE_SIZE         | warning  | 代码超过 4096 字符 |
| TOO_MANY_LOOPS    | warning  | 嵌套循环超过 3 层  |
| NO_ERROR_HANDLING | info     | 建议添加 try-catch |
| INPUT_VALIDATION  | info     | 建议验证输入字段   |
| DEEP_NESTING      | warning  | 嵌套深度超过 4 层  |

## 10. 与现有实现的映射

| 功能         | 当前状态                   | 需要完善               |
| ------------ | -------------------------- | ---------------------- |
| 版本生命周期 | ✅ 基本实现                | 增加 `generating` 状态 |
| 版本不可变   | ✅ 每次保存创建新版本      | -                      |
| 版本指针     | ✅ draft/published         | -                      |
| 测试框架     | ✅ 添加/删除/运行/生成     | 增加覆盖率             |
| 数据源管理   | ✅ 编辑/快照/迁移/应用     | -                      |
| 发布流程     | ✅ 密钥/调用/文档          | 增加密钥轮换           |
| 调度任务     | ✅ 定时执行                | 增加 cron 表达式       |
| 运行记录     | ✅ 状态/触发/日志          | 增加筛选/搜索          |
| 代码质量门禁 | ✅ 质量评分 + 诊断规则     | 增加覆盖率指标         |
| 自动修订     | ✅ `deepSeekRevise()`      | 多轮对话式修订         |
| 小程序互联   | ✅ `ctx.call()` 深度限制 3 | 增加能力注册表         |
