# RFC 0007：LLM API 自动探索与智能生成

- 状态：Proposed
- 日期：2026-08-10

## 1. 目的

当前 Hosta 的 LLM 集成较为简单（直接调用 DeepSeek 生成代码），需要扩展为更智能的生成管线，支持：

- 自动需求分析与结构化提取
- 多轮代码生成与优化
- 基于运行反馈的自动修订
- 代码质量评分与建议
- 探索式 API 能力发现

## 2. LLM 生成管线

```text
用户输入需求描述
    │
    ▼
┌──────────────────────────────┐
│ 1. 需求分析 (Analyze)         │
│    - 提取关键实体和操作        │
│    - 识别输入输出 schema       │
│    - 判断是否需要外部能力      │
│    - 生成结构化 spec           │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ 2. 代码生成 (Generate)        │
│    - 基于 spec 生成 JS 代码   │
│    - 遵循 main(input, ctx) 契约│
│    - 生成测试用例              │
│    - 生成示例输入              │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ 3. 静态校验 (Validate)        │
│    - JSON schema 校验         │
│    - 语法解析                 │
│    - 禁用 API 扫描            │
│    - 代码大小检查             │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ 4. 自动测试 (Auto-Test)       │
│    - 运行 LLM 生成的测试用例   │
│    - 捕获运行时错误和日志      │
│    - 记录测试结果              │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ 5. 反馈分析 (Feedback)        │
│    - 分析失败原因              │
│    - 判断是否可自动修复        │
│    - 生成修复建议              │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ 6. 修订生成 (Revise)          │
│    - 将错误信息反馈给 LLM      │
│    - 生成修订版本              │
│    - 重新进入校验流程          │
└──────────────────────────────┘
```

## 3. 详细设计

### 3.1 需求分析（Analyze Phase）

**输入**：用户自然语言描述 + 可选示例输入

**LLM Prompt 结构**：

```
You are a requirements analyst for a lightweight automation platform.
Analyze the user's request and extract:

1. What data does the program receive? (input schema)
2. What operations does it perform? (transform, filter, aggregate, validate, etc.)
3. What data does it return? (output schema)
4. Does it need external capabilities? (network, storage, etc.)
5. What edge cases should be considered?

User request: {description}
Sample input: {sampleInput}

Return JSON: { "summary": "...", "inputSchema": {...}, "outputSchema": {...},
  "operations": [...], "capabilities": [...], "edgeCases": [...], "complexity": "low|medium|high" }
```

**输出**：结构化的需求分析结果，用于驱动后续生成

### 3.2 代码生成（Generate Phase）

**输入**：需求分析结果 + 运行时信息

**当前实现**：`deepSeekGenerate()` 函数，一次性生成代码 + 测试

**改进方向**：

- 将需求分析结果注入生成 prompt，提高生成质量
- 支持根据 `complexity` 调整 `max_tokens`
- 对于高复杂度需求，使用 chain-of-thought

### 3.3 自动修订（Revise Phase）

**输入**：原始代码 + 测试失败信息 + 运行时错误

**触发条件**：

- 自动测试失败
- 用户点击"根据错误修订"
- 用户追加修改要求

**当前实现**：`deepSeekGenerateTests()` 已实现测试生成，但缺少自动修订闭环

**改进方向**：

- 新增 `POST /api/versions/:id/revise` 端点
- 将错误信息（测试失败、运行时错误）反馈给 LLM
- 限制修订轮数（默认最多 3 轮）
- 每轮修订产生新版本

### 3.4 代码质量评分

**在生成/修订后自动评估**：

- 语法正确性（静态分析）
- 测试覆盖率（测试用例数量 vs 分支数）
- 错误处理（try-catch 使用）
- 日志完整性（ctx.log 调用点）
- 代码简洁性（行数、复杂度）

**评分展示**：

```
代码质量：★★★★☆ (4/5)
- 语法正确 ✅
- 测试覆盖：3 个用例
- 错误处理：缺少 try-catch
- 日志：2 个日志点
- 简洁性：12 行
```

### 3.5 探索式 API 能力发现

**问题**：用户不知道 LLM 能生成什么类型的程序

**解决方案**：LLM 自动探索 API 能力

```text
GET /api/discover?capability=network
→ 返回所有已启用网络能力的小程序示例

GET /api/discover?capability=data-transform
→ 返回所有数据转换类小程序调用文档
```

**实现**：

- 在 `/api/discover` 响应中增加 `capabilities` 字段
- 每个程序的 `invoke-docs` 中增加输入输出 schema
- LLM Agent 可通过 `/llms.txt` 发现所有可用能力

### 3.6 提示词管理

**当前问题**：所有 prompt 硬编码在 `server.mjs` 中

**改进方向**：

- 提取 prompt 模板到独立文件或配置
- 支持 prompt 版本管理
- 支持 A/B 测试不同 prompt
- 记录每次生成使用的 prompt 版本

**Prompt 模板结构**：

```json
{
  "version": "1.0",
  "templates": {
    "generate": "You generate a small Hosta JavaScript function...",
    "analyze": "You are a requirements analyst...",
    "revise": "The previous version had these errors...",
    "generate-tests": "You are a test engineer..."
  }
}
```

## 4. 与现有实现的映射

| 功能         | 当前状态                                  | 目标                |
| ------------ | ----------------------------------------- | ------------------- |
| 需求分析     | 隐含在 `deepSeekGenerate()` 中            | 独立的 analyze 阶段 |
| 代码生成     | ✅ `deepSeekGenerate()`                   | 注入需求分析结果    |
| 静态校验     | ✅ `diagnosticsFor()`                     | 增加质量评分        |
| 自动测试     | ✅ 生成后运行测试                         | 增加覆盖率分析      |
| 自动修订     | ✅ `deepSeekRevise()` + `/revise` 端点    | 增加多轮对话修订    |
| 测试生成     | ✅ `deepSeekGenerateTests()`              | 增加边界用例生成    |
| 示例输入生成 | ✅ `deepSeekSample()`                     | 增加 schema 约束    |
| 能力发现     | ✅ `/api/discover` 含 capabilities/schema | 增加能力注册表      |
| 代码质量评分 | ✅ `codeQualityScore()`                   | 增加覆盖率指标      |
| Prompt 管理  | 硬编码                                    | 提取到配置文件      |

## 5. 实现优先级

### 本次实现（Phase 1）

- [x] 基本代码生成（`deepSeekGenerate`）
- [x] 测试生成（`deepSeekGenerateTests`）
- [x] 示例输入生成（`deepSeekSample`）
- [x] 静态校验（`diagnosticsFor`）
- [ ] 需求分析阶段（新增 `analyze` prompt）
- [x] 自动修订端点（`POST /api/versions/:id/revise`，含容错 JSON 解析）
- [x] 代码质量评分展示（`codeQualityScore` + 前端 `quality-score` 徽章）
- [x] 能力发现增强（`/api/discover` 返回 inputSchema/outputSchema/capabilities/callExample）
- [ ] Prompt 模板提取

### 后续实现（Phase 2+）

- [ ] 多轮对话式修订
- [ ] 代码优化建议
- [ ] 探索式能力发现
- [ ] A/B prompt 测试
- [ ] 多模型支持（Claude, GPT-4, etc.）
