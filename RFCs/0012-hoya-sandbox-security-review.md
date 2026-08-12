# RFC 0012：Hoya 低成本沙箱安全审查与演进建议

- 状态：Informational（代码审查与风险登记；部分发现已在 Hoya 修复）
- 日期：2026-08-12
- 审查对象：`hoya` commit `ea908bd5388167bbc7b0fe2d9c790adcd8962f0a`
- 关联文档：[`RFC 0011`](0011-llm-sandbox-landscape-survey.md)、[`hoya/KNOWN_GAPS.md`](../../hoya/KNOWN_GAPS.md)
- 相关代码：[`hoya/src/main.rs`](../../hoya/src/main.rs)、[`hoya/src/js_engine`](../../hoya/src/js_engine)、[`hoya/src/wasm_engine`](../../hoya/src/wasm_engine)、[`hoya/src/handlers.rs`](../../hoya/src/handlers.rs)、[`src/hoya-client.ts`](../src/hoya-client.ts)、[`src/executor.ts`](../src/executor.ts)

## 1. 结论

Hoya 当前适合作为 **Hosta 本地单用户、受控网络中的低成本 sidecar 执行器**，但还不能作为公网、多租户、可承载主动恶意代码的安全边界。

QuickJS 与 Wasmtime 的能力模型方向是对的：用户代码默认拿不到文件系统、进程和任意宿主对象，相比 `vm.createContext` 明显收窄了攻击面；JS 有 QuickJS 内存上限和中断回调，新 WASM API 路径有 fuel、线性内存和栈限制，容器镜像也使用非 root 用户。这些都是值得保留的基础。

不过，当前服务同时存在两套执行路径：

1. `/execute`、`/execute/js`、`/execute/wasm` 是较新的 API 路径；
2. `/create`、`/execute/:id` 是遗留 Web UI 路径。

第二套路径绕过了第一套路径的大部分鉴权与资源治理，因此不能用“新 API 已加限制”推导“整个服务已安全”。此外，网络、输出缓冲、数据注入和 Hosta/WASM 调用协议仍有明显缺口。`hoya/KNOWN_GAPS.md` 中“所有问题已全部修复”的结论应视为过期。

建议的产品口径是：

> Hoya 是进程内、能力受限、带基础资源计量的执行引擎，不是 OS 级强隔离沙箱。生产侧车模式必须只监听 loopback、强制鉴权、关闭遗留 UI，并由固定并发和宿主级资源上限兜底。

## 2. 审查范围与威胁模型

本次审查覆盖：HTTP 暴露面、鉴权、JS/QuickJS 执行、WASM/Wasmtime 执行、host FFI、出网、资源限制、Hosta sidecar 生命周期、Docker/Kubernetes 配置和现有测试。

主要保护目标：

- Hosta 进程、宿主文件和环境变量不被用户代码读取或修改；
- 内网服务、云 metadata、loopback 服务不被沙箱代码探测或调用；
- 单次执行不能无限占用 CPU、内存、线程或网络；
- 一个应用的调用者不能借输入注入获得该应用未预期的代码执行和数据源权限；
- 失败不能被误报为成功，资源限制不能只存在于文档中。

未进行破坏性 DoS、真实内网探测或引擎 0-day 利用。本结论来自静态代码审查、本地构建检查和执行路径分析，不等同于第三方渗透测试或形式化验证。

## 3. 风险总览

| ID | 等级 | 问题 | 主要影响 | 建议时点 |
| --- | --- | --- | --- | --- |
| H-01 | Critical | 遗留 Web UI 未鉴权即可创建和执行代码 | 远程代码执行入口、宿主 DoS | 对外部署前立即修复 |
| H-02 | 已修复 | 遗留 WASM 路径没有有效 CPU/墙钟/内存治理 | 已统一到受限 Wasmtime 路径 | 继续维持回归测试 |
| H-03 | High | 三条下载/`fetch` 路径均可绕过出网边界 | SSRF、内网/metadata 访问、无界下载 | 立即修复 |
| H-04 | High | JS `input` 通过模板字符串拼接进代码 | 调用者可注入 JS，并继承应用的数据源/出网能力 | 立即修复 |
| H-05 | High | stdout/stderr、返回值和 HTTP body 在宿主侧无统一硬上限 | 绕过 VM 内存限制，撑爆 Hoya/Hosta | 立即修复 |
| H-06 | 已修复 | Hoya WASM 路径只调用 `_start`，没有 `main` 仍返回成功 | Hosta API 强制 `main() -> i32`；旧 API 只兼容明确的 `_start()` | 继续维持 ABI 测试 |
| H-07 | 部分修复 | CPU 执行和同步 FFI 占用 Tokio worker | guest 执行移至有界 blocking pool；同步 FFI 仍需在 egress 重构时处理 | 性能压测前完成 |
| H-08 | 部分修复 | 每请求创建引擎、编译模块和 HTTP client | 已复用 Engine/client，并加 64-entry LRU module cache；编译预算仍待治理 | 完成安全 P0 后优化 |
| H-09 | Medium | Sidecar crash-loop、就绪探测与部署配置不够稳健 | 错误实例被判 ready、反复重启、意外公网暴露 | 生产化前修复 |
| H-10 | Architecture | QuickJS/Wasmtime 与 broker 同进程 | 引擎漏洞或 Rust host panic 的爆炸半径是整个 Hoya 进程 | 多租户前升级边界 |

## 4. 详细发现

### H-01：遗留 Web UI 绕过执行 API 的鉴权

`require_auth` 和 16 MiB body limit 只挂在 `/execute*` Router 上；`/create` 与 `/execute/:id` 在外层 Router，未鉴权。服务默认监听 `0.0.0.0`，Kubernetes Service 还是 `LoadBalancer`，因此在按仓库配置部署时，外部访问者可以先上传 JS/WASM，再触发执行。

这不是“只有管理页面没登录”的普通问题，而是另一条完整的任意代码执行入口。生产模式应删除这套路由，或至少与执行 API 共用完全相同的认证、请求体、并发和配额中间件。sidecar 默认监听地址应改为 `127.0.0.1`，只有显式配置才允许对外监听；生产模式缺少 token 时应拒绝启动，而不是 fail-open。

### H-02：遗留 WASM 路径的资源限制实际未生效

**状态：已于 2026-08-12 修复。** UI 的 WASM 执行现在委托给与 `/execute/wasm` 相同的实现；原有的重复 Wasmtime 初始化和无约束 imported memory 代码已移除。统一路径启用 100,000 fuel、32 MiB `StoreLimiter`、500 KiB WASM stack、每 10 ms 推进的 epoch 时钟与 5 秒 deadline；无限循环、超过 32 MiB 的 `memory.grow` 均由单元测试覆盖。

`handlers.rs` 中的旧 WASM 执行器创建了启用 epoch interruption 的 Engine，但没有设置 epoch deadline，也没有递增 epoch；它没有启用 fuel，`StoreLimiter` 代码被注释掉，用户提供的 `timeout` 只被写入响应 metadata。

更严重的是，`memory_pages` 校验允许 `1..=65536`，随后直接作为 imported memory 的最小值和最大值；65536 页等于 4 GiB。攻击者既可以执行无限循环，也可以请求巨大的初始线性内存。此路径不值得单独修补，建议删除重复执行器，让 UI（若保留）也调用 `wasm_engine::execute_wasm_with_input`。

### H-03：出网策略可被绕过，响应体限制名实不符

当前至少有三套网络实现：

- `/execute` 使用 `reqwest::get` 下载代码，没有 scheme/目标地址校验、总超时和流式大小上限；请求体的 16 MiB 限制不限制下载内容；
- JS `fetch` 只按 hostname 字符串阻止 `127.0.0.1`、`localhost`、`::1`、`0.0.0.0`，未阻止 RFC1918、link-local、云 metadata、IPv4 的非标准写法、IPv4-mapped IPv6、DNS 重绑定和跳向内网的重定向；读取完整 `text()` 后才判断 512 KiB；
- WASM `fetch` 没有任何 scheme/host/IP 限制，允许任意方法、headers 和 body，并将完整响应读入 String；代码中没有 512 KiB 限制，但 `/api` 文档宣称存在该限制。

应收敛为唯一的 `EgressPolicy + FetchService`：只允许 `http/https`；解析 DNS 后校验所有目标 IP；默认拒绝 loopback、private、link-local、multicast、unspecified 和 metadata 地址；固定解析结果或在连接层绑定已校验 IP；关闭自动重定向并逐跳重新校验；按 chunk 流式读取并在超限时立即中止；限制请求 body、响应 headers、重定向次数和每次执行的请求次数。对于 Hosta 的已知数据源，域名 allowlist 比 denylist 更可靠。

### H-04：外部输入可通过模板字符串注入 JS

`execute_js_with_input` 先把 JSON 序列化为字符串，再生成如下 JavaScript：

```javascript
var input = JSON.parse(`{input_str}`);
```

JSON 编码不会为 JavaScript 模板字符串转义反引号和 `${...}`。因此发布应用的 HTTP 调用者只需在字符串字段中放入 `${...}` 或反引号，就能改变待执行代码。虽然应用代码本身已经是不可信代码，但应用调用者与应用作者是不同信任域；该注入会让普通调用者获得该应用被授予的 `datasource`、日志和全局 `fetch` 能力。

不要自己拼 JavaScript 源码。应使用 rquickjs 的 Rust-to-JS conversion/Object API，把 `input` 和 `datasource` 作为真正的 JS value 设置到 global 或直接作为函数实参。若暂时保留 JSON 字符串，也应作为 host value 传入后在沙箱内解析，而不是插值进源码。

### H-05：宿主缓冲没有总量上限

QuickJS 的 64 MiB 限制只约束 QuickJS heap，不约束 Rust 的 `String`。`console.log`/`console.error` 每次都把内容追加到 `Arc<Mutex<String>>`；WASM 的 `app_log`、`capture_stdout` 和 `capture_stderr` 同样无限追加。脚本可反复提交同一段大日志，使宿主内存远超 VM 限制。结果字符串、FFI response、Hosta client 收到的 HTTP response 也没有统一上限。

建议为每次执行建立共享 `ExecutionBudget`，至少包含：代码、input、datasource、单条日志、日志条数、stdout、stderr、结果、单次 fetch、累计 fetch、host-call 次数和总墙钟时间。所有写入采用“剩余额度”截断或返回稳定错误码；HTTP client 在解析前也要限制响应字节。额度必须作用于宿主分配，而不仅是 guest heap。

### H-06：Hoya 与 Hosta 的 WASM ABI 不兼容

**状态：已于 2026-08-12 修复。** `/execute/wasm` 现在强制 Hosta ABI：module 必须 export `memory` 与 `main() -> i32`，返回指向 NUL 终止 JSON envelope 的指针。缺少 `main` 是错误而非成功。保留的 URL `/execute` standalone compatibility path 只接受明确的 `_start()`，不再把“仅实例化成功”报为执行成功。

Hosta 原路径要求 module export `main`，读取其返回的字符串指针并解析 JSON envelope。Hoya 新路径只尝试 `instance.get_typed_func::<(), ()>("_start")`；若没有 `_start`，仍返回 `status: success` 和 “instantiated” 文本。即使存在 `_start`，返回值也只是固定说明文字。结果是开启 Hoya 后，某些 WASM 应用根本没有执行 `main`，Hosta 却记录为成功。

需要先确定唯一 ABI：建议继续采用 RFC 0010 的 JSON envelope；明确导出名、函数签名、内存/alloc 约定、async 语义和错误码。找不到入口函数必须失败。为 Rust 与 MoonBit fixture 建立 Hosta→Hoya 的端到端契约测试。

### H-07：同步执行阻塞异步服务 worker

**状态：部分修复。** JS/WASM API 和遗留 UI 的 guest 执行均已通过 `spawn_blocking` 移出 Tokio I/O worker，且由全局 semaphore 控制并发（默认 4，可由 `HOYA_MAX_CONCURRENT_EXECUTIONS=1..64` 配置）。WASM host `fetch` 仍使用同步桥接；它将在 H-03 的统一 egress service 中一并改造。

Axum handler 直接同步运行 QuickJS、Wasmtime 编译与执行。JS/WASM 的 `fetch` 又在同步 host function 内用 `block_in_place + Handle::block_on`。单个调用虽有部分超时，但多个 CPU 密集请求会占满 Tokio worker；大量慢网络调用会消耗 blocking pool，并造成健康检查和正常请求排队。

最低成本方案是设置全局与 per-engine `Semaphore`、有界等待队列和快速 429/503 拒绝，并把 CPU 密集的编译/执行放到专用有界线程池。更稳妥的折中是“常驻 broker + 固定数量 worker 子进程”：仍比每次启动容器便宜，但可在超时或 OOM 时杀掉单个 worker，避免 Hoya broker 一起退出。

### H-08：热路径重复初始化，且编译阶段不受 fuel 约束

**状态：部分修复。** Wasmtime `Engine` 和禁用宿主代理发现的 reqwest `Client` 现为进程级单例；已编译 module 按 SHA-256 内容哈希进入 64-entry LRU cache。编译本身仍不是 fuel 覆盖范围，故大 module/复杂 module 的编译 CPU 与缓存总字节上限仍属后续工作。

WASM 每次请求都新建 `Engine`、`Module` 和 `reqwest::Client`；JS fetch 每次也新建 client。Wasmtime fuel 只覆盖 guest 执行，不覆盖解析、验证和 JIT 编译，多个接近 body limit 的复杂 module 可用编译开销压垮服务。

建议全局复用不可变 Wasmtime `Engine` 和配置，复用带连接池的 HTTP client；对已验证 module 按内容哈希做有界 LRU cache，并限制缓存总字节与租户占比。不要复用带用户全局状态的 QuickJS Context；如果要优化 JS，只复用线程和不可变初始化快照，并先证明每次调用状态完全清零。

### H-09：Sidecar 与部署层还有失效模式

- Hoya 默认绑定全网卡，Kubernetes Service 对外暴露，ConfigMap 使用未被程序读取的 `SERVER_PORT`，且没有配置 `HOYA_AUTH_TOKEN`；
- Hosta 只探测端口上的 `/health`，没有验证返回实例是否是刚拉起、持有同一 token 的 Hoya；端口已被其他进程占用时可能短暂误判 ready；
- 自动重启次数在每次成功 ready 后归零，因此“启动成功后立即崩溃”的循环永远到不了 5 次上限；
- Kubernetes 虽有 CPU/内存 limit 和非 root 镜像，但缺少 `readOnlyRootFilesystem`、`allowPrivilegeEscalation: false`、capability drop、seccomp profile 和默认拒绝出网的 NetworkPolicy。

健康/就绪检查应返回启动时随机 instance ID，并提供需 bearer token 的 `/ready/private`；Hosta 必须验证 instance ID。crash budget 应按时间窗口计算而不是一次 ready 就归零。

### H-10：进程内隔离的固有上限

QuickJS 和 Wasmtime 的 guest 能力隔离不等于进程隔离。若解释器/JIT/host FFI 出现内存安全漏洞或 panic-abort，攻击/故障可影响整个 Hoya 进程；Hoya 与 Hosta 虽是不同进程，已经比直接嵌入 Hosta 好，但同一 Hoya 内的并发租户仍共享爆炸半径。

本地单用户 MVP 可以接受这个风险，不必为了“理论最强”立即引入 Firecracker。进入半信任或多租户 SaaS 前，至少应把执行下沉到受限 worker 进程，并使用 cgroup v2/容器限制 CPU、memory、pids、fd 和网络；公网恶意代码场景再评估 gVisor、Kata、Firecracker 或采购沙箱服务。

## 5. 推荐演进路线

### P0：先把“限制确实生效”做实（建议 1–3 天）

1. 生产构建关闭 `/create`、`/execute/:id` 等遗留 UI，或统一挂载 auth、body、并发和配额中间件；删除 `handlers.rs` 中的第二套执行器。
2. 默认监听 `127.0.0.1`；新增明确的 `HOYA_MODE=development|sidecar|service`，sidecar/service 缺少 token 时 fail-closed。
3. 修复 JS input 注入，所有 Rust→JS 数据通过绑定 API 传值。
4. 合并三套网络实现，完成 DNS/IP/redirect 逐跳验证和流式硬上限；在完成前可先默认禁用 guest fetch。
5. 引入统一 `ExecutionBudget`，给宿主日志、结果和累计网络字节加硬上限。
6. 明确 Hosta WASM ABI；没有正确入口或返回 envelope 时必须失败。

### P1：资源治理与可验证性（建议 1–2 周）

1. 增加全局/per-tenant/per-engine 并发 semaphore、有界队列、429/503 和请求取消传播。
2. Wasmtime 同时使用 fuel 与 epoch deadline：fuel 控制 guest 指令，epoch 控制墙钟；host call 自己有独立 deadline/次数/字节预算。
3. 将编译和执行移到专用有界 worker；至少隔离 Tokio IO worker。
4. 添加安全回归测试：无限循环、内存增长、日志洪泛、超大结果、恶意 input、所有私网地址写法、DNS/redirect、慢响应、WASM ABI、并发过载。
5. 指标至少包括 queue time、compile time、run time、fuel consumed、guest/host bytes、fetch 次数/字节、timeout/OOM/limit reason、active executions 和 rejected executions。

### P2：引擎性能优化（安全基线之后）

1. 全局复用 Wasmtime Engine、Linker 模板和 reqwest Client；用内容哈希做有界 module cache。
2. 将 module compile time 与 execution time 分开计量；为常用 module 预热或持久化预编译 artifact，并绑定 Wasmtime 版本/target/config 校验。
3. QuickJS 保持“一次请求一个 Runtime/Context”的干净边界；通过线程池、预注册 immutable bootstrap 和减少 JSON 往返优化，而不是复用用户 Context。
4. 统一 JS/WASM 的 response envelope 和错误分类，避免 Hosta 做字符串猜测；让结果保持 JSON value，不进行多次 stringify/parse。
5. 压测后再调 fuel：固定 `100,000` 既可能过小导致正常 module 失败，也可能无法表达不同套餐；应基于基准 workload 转换为可观察的 compute unit。

### P3：多租户触发条件

出现任一条件时，启动新的隔离架构 RFC：允许公网用户直接提交代码；同一 Hoya 服务承载不同组织；宿主持有生产密钥/内网权限；需要合规审计；单次执行价值足以吸引主动攻击。

推荐的低成本升级顺序是：

```text
进程内 Runtime
  → 固定 worker 子进程池 + rlimit/cgroup + 受控网络代理
  → 每租户容器/gVisor
  → MicroVM 或 Sandbox-as-a-Service
```

## 6. 验收清单

在把 Hoya 标记为 “Hosta production sidecar ready” 前，应满足：

- [ ] 生产模式不存在未鉴权的代码写入或执行路由；
- [ ] 只监听预期地址，token 缺失时拒绝启动；
- [ ] JS input/datasource 不通过源码字符串插值；
- [ ] 所有 URL 在 DNS 解析后、每次 redirect 前都执行统一 egress policy；
- [ ] 下载、guest fetch、日志、结果、请求/响应都有流式字节硬上限；
- [ ] JS 死循环和 WASM 死循环均在墙钟限制内结束；
- [ ] guest heap/linear memory 与 host buffer 都有独立预算；
- [ ] Hosta WASM fixture 的 `main` 确实执行并返回正确 envelope；
- [ ] 超载时快速拒绝，不拖死 `/health` 和 `/ready`；
- [ ] worker 被 kill/OOM/panic 后，其他执行和 broker 仍可服务；
- [ ] 安全回归测试进入 CI，限制值与 `/api` 文档由同一配置源生成；
- [ ] Kubernetes 使用 ClusterIP/loopback sidecar、NetworkPolicy、restricted securityContext 和 Secret；
- [ ] 依赖漏洞扫描、Rust lint 和最小化镜像检查进入 CI。

## 7. 本次验证记录

- `cargo test --all-targets`：通过，但项目当前共有 **0 个测试**；因此只能证明可构建，不能证明限制有效。
- `cargo clippy --all-targets -- -D warnings`：失败，共报告 17 个 error，主要是 dead code 和普通 lint；不是直接漏洞，但说明尚未建立严格 CI 基线。
- `cargo audit`：本机未安装，未完成依赖 CVE 扫描；建议 CI 使用 RustSec database 或等价 SCA。
- 工作区在审查前已有 Hoya 模板和 Hosta 前端/管理路由的未提交修改；本次未改动这些文件，只新增本 RFC 并更新 RFC 索引。

## 8. 最终判断

Hoya 的核心取舍是合理的：用 QuickJS/Wasmtime 换取毫秒级启动和很低的单位执行成本，并把 Hosta 从 `vm.createContext` 提升到显式 capability 模型。当前最大问题不是“必须立刻换成 MicroVM”，而是同一仓库中重复执行路径、策略分叉和宿主资源无上限，使已经实现的安全能力能够被旁路。

先完成 P0/P1，Hoya 可以成为可信的本地/单租户 sidecar；在没有 worker 进程或 OS 级资源边界前，不应把它宣传或部署成面向主动恶意多租户的通用沙箱。
