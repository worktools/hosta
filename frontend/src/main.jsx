import React, {
  useEffect,
  useMemo,
  useState,
  useCallback,
  useRef,
} from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Routes,
  Route,
  NavLink,
  useParams,
  useNavigate,
  Outlet,
  useLocation,
  useOutletContext,
} from "react-router-dom";
import "./styles.css";

// ── generative-lego imports ─────────────────────────────────────────────────
import { GuiFramework } from "@generative-lego/gui-framework";
import {
  Button,
  Input,
  Select,
  Form,
  Table,
  Card,
  Modal,
  Tabs,
  DatePicker,
  Layout as LegoLayout,
  Chart,
  Checkbox,
  Radio,
  Switch,
  Slider,
  InputNumber,
  Rate,
  Tag,
  Divider,
  Badge,
  Space,
  Empty,
  Skeleton,
  Progress,
  Alert,
  Avatar,
  Statistic,
  Link,
  Breadcrumb,
  Steps,
  Timeline,
  Collapse,
  List,
  Result,
  Descriptions,
  Pagination,
  Segmented,
  Drawer,
  Popover,
  Image,
  TimePicker,
  Tree,
  Tooltip,
} from "@generative-lego/lego-react";

const legoComponentRegistry = {
  button: Button,
  input: Input,
  select: Select,
  form: Form,
  table: Table,
  card: Card,
  modal: Modal,
  tabs: Tabs,
  datePicker: DatePicker,
  layout: LegoLayout,
  chart: Chart,
  checkbox: Checkbox,
  radio: Radio,
  switch: Switch,
  slider: Slider,
  inputNumber: InputNumber,
  rate: Rate,
  tag: Tag,
  divider: Divider,
  badge: Badge,
  space: Space,
  empty: Empty,
  skeleton: Skeleton,
  progress: Progress,
  alert: Alert,
  avatar: Avatar,
  statistic: Statistic,
  link: Link,
  breadcrumb: Breadcrumb,
  steps: Steps,
  timeline: Timeline,
  collapse: Collapse,
  list: List,
  result: Result,
  descriptions: Descriptions,
  pagination: Pagination,
  segmented: Segmented,
  drawer: Drawer,
  popover: Popover,
  image: Image,
  timePicker: TimePicker,
  tree: Tree,
  tooltip: Tooltip,
};

const api = async (path, options = {}) => {
  const res = await fetch(path, {
    headers: { "content-type": "application/json", ...options.headers },
    ...options,
  });
  const value = await res.json();
  if (!res.ok) throw new Error(value.error?.message || "Request failed");
  return value;
};
const emptyJs = `async function main(input, ctx) {\n  ctx.log('info', 'started');\n  return { ok: true, received: input };\n}`;
const rustStarter = `#![no_std]\n#![no_main]\n\n#[unsafe(no_mangle)]\npub extern "C" fn main() -> i32 {\n  42\n}\n\n#[panic_handler]\nfn panic(_: &core::panic::PanicInfo) -> ! { loop {} }\n`;
const moonStarter = `pub fn run() -> Int {\n  42\n}\n`;
const copy = (value) => navigator.clipboard.writeText(value);

// ── Toast 通知系统 ────────────────────────────────────────────────────────────
let toastId = 0;
function ToastContainer({ toasts, dismiss }) {
  return React.createElement(
    "div",
    { className: "toast-container" },
    toasts.map((t) =>
      React.createElement(
        "div",
        {
          key: t.id,
          className: `toast toast-${t.type || "info"}`,
          onClick: () => dismiss(t.id),
        },
        React.createElement(
          "span",
          { className: "toast-icon" },
          t.type === "success" ? "✓" : t.type === "error" ? "✗" : "ℹ",
        ),
        React.createElement("span", { className: "toast-msg" }, t.message),
      ),
    ),
  );
}

// ── AI Drawer — unified AI editing interaction ─────────────────────────────────
/**
 * Props:
 *   open          — boolean
 *   onClose       — () => void
 *   title         — drawer header text
 *   goal          — description of what AI will do
 *   context       — React node shown as read-only context
 *   placeholder   — instruction input placeholder
 *   onGenerate    — async (instruction: string) => { summary: string, result: any }
 *   onApply       — (instruction: string, result: any) => void (called after user confirms)
 *   applyLabel    — label for apply button (default "✓ 应用")
 */
function AIDrawer({
  open,
  onClose,
  title,
  goal,
  context,
  placeholder = "告诉 AI 重点关注什么…",
  onGenerate,
  onApply,
  applyLabel = "✓ 应用",
}) {
  const [instruction, setInstruction] = useState("");
  const [generating, setGenerating] = useState(false);
  const [summary, setSummary] = useState("");
  const [result, setResult] = useState(null);

  // reset on open
  useEffect(() => {
    if (open) {
      setInstruction("");
      setGenerating(false);
      setSummary("");
      setResult(null);
    }
  }, [open]);

  const generate = async () => {
    if (!instruction.trim() || !onGenerate) return;
    setGenerating(true);
    setSummary("");
    setResult(null);
    try {
      const { summary: s, result: r } = await onGenerate(instruction.trim());
      setSummary(s);
      setResult(r);
    } finally {
      setGenerating(false);
    }
  };

  const apply = () => {
    if (onApply) onApply(instruction.trim(), result);
    onClose();
  };

  if (!open) return null;

  return (
    <div className="ai-drawer-overlay" onClick={onClose}>
      <div className="ai-drawer" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="ai-drawer__header">
          <h3>AI 编辑：{title}</h3>
          <button className="close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="ai-drawer__body">
          {/* Goal */}
          <div className="ai-drawer__section">
            <span className="ai-drawer__section-label">目标</span>
            <span className="ai-drawer__goal">{goal}</span>
          </div>

          {/* Context */}
          {context && (
            <div className="ai-drawer__section">
              <span className="ai-drawer__section-label">上下文</span>
              <pre className="ai-drawer__context">{context}</pre>
            </div>
          )}

          {/* Instruction + Generate */}
          <div className="ai-drawer__section">
            <span className="ai-drawer__section-label">你的批注</span>
            <div className="ai-drawer__instruction-row">
              <input
                className="ai-drawer__instruction"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder={placeholder}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !generating) generate();
                }}
                autoFocus
              />
              <button
                className="primary"
                onClick={generate}
                disabled={generating || !instruction.trim()}
              >
                {generating ? "生成中…" : "✨ 生成"}
              </button>
            </div>
          </div>

          {/* Result */}
          {result != null && (
            <div className="ai-drawer__section">
              <span className="ai-drawer__section-label">生成结果</span>
              <div className="ai-drawer__result">
                {summary && (
                  <div className="ai-drawer__result-summary">{summary}</div>
                )}
                <pre className="ai-drawer__result-content">
                  {typeof result === "string"
                    ? result
                    : JSON.stringify(result, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="ai-drawer__footer">
          <button className="ghost" onClick={onClose}>
            放弃
          </button>
          <button className="primary" onClick={apply} disabled={result == null}>
            {applyLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function Layout() {
  const [apps, setApps] = useState([]);
  const [toasts, setToasts] = useState([]);
  const [stats, setStats] = useState(null);
  const toast = useCallback((message, type = "info") => {
    const id = ++toastId;
    setToasts((prev) => [...prev.slice(-4), { id, message, type }]);
    setTimeout(
      () => setToasts((prev) => prev.filter((t) => t.id !== id)),
      3500,
    );
  }, []);
  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);
  const refresh = useCallback(async () => {
    const data = await api("/api/apps");
    setApps(data);
  }, []);
  useEffect(() => {
    refresh().catch((e) => toast(e.message, "error"));
    api("/api/stats")
      .then(setStats)
      .catch(() => {});
  }, []);
  const location = useLocation();
  const isEditor =
    location.pathname.startsWith("/apps/") &&
    location.pathname.split("/").length >= 3;
  const currentApp = useMemo(() => {
    if (!isEditor) return null;
    const id = location.pathname.split("/")[2];
    return apps.find((a) => a.id === id) || null;
  }, [apps, location.pathname, isEditor]);

  return (
    <div className="shell">
      <aside>
        <div className="brand">
          <span className="mark">H</span>
          <span>hosta</span>
        </div>
        <nav>
          <NavLink to="/" end>
            程序
          </NavLink>
          <NavLink to="/new">新建程序</NavLink>
          <NavLink to="/stats">访问统计</NavLink>
          <a href="/llms.txt" target="_blank">
            LLM Agent 指南 ↗
          </a>
        </nav>
        <div className="side-label">最近程序</div>
        <div className="app-nav">
          {apps.map((app) => (
            <NavLink key={app.id} to={`/apps/${app.id}/requirements`}>
              <span className="dot"></span>
              {app.name}
            </NavLink>
          ))}
        </div>
        <div className="sidebar-bottom">
          Local workspace
          <br />
          DeepSeek ready
        </div>
      </aside>
      <main>
        <header>
          <div>
            <span className="crumb">
              Workspace /{" "}
              {isEditor
                ? currentApp?.name || "Program"
                : location.pathname === "/new"
                  ? "New program"
                  : location.pathname === "/stats"
                    ? "Statistics"
                    : "Programs"}
            </span>
            <h1>
              {isEditor
                ? currentApp?.name || ""
                : location.pathname === "/new"
                  ? "创建程序"
                  : location.pathname === "/stats"
                    ? "访问统计"
                    : "程序"}
            </h1>
          </div>
          <div className="header-actions">
            <span className="runtime">
              {currentApp?.runtime || "javascript"}
            </span>
            <button className="ghost" onClick={() => refresh()}>
              刷新
            </button>
          </div>
        </header>
        <Outlet context={{ apps, refresh, toast, stats }} />
        <ToastContainer toasts={toasts} dismiss={dismissToast} />
      </main>
    </div>
  );
}

function useLayout() {
  return useOutletContext();
}

// ── AppsPage ────────────────────────────────────────────────────────────────
function AppsPage() {
  const { apps } = useLayout();
  const navigate = useNavigate();
  return (
    <AppList
      apps={apps}
      open={(id) => navigate(`/apps/${id}/requirements`)}
      create={() => navigate("/new")}
    />
  );
}

// ── NewAppPage ──────────────────────────────────────────────────────────────
function NewAppPage() {
  const { refresh, toast } = useLayout();
  const navigate = useNavigate();
  const [draft, setDraft] = useState({
    name: "",
    description: "",
    requirements: "",
    runtime: "javascript",
    language: "rust",
    sample: '{\n  "value": 1\n}',
  });
  const create = async (event) => {
    event.preventDefault();
    try {
      const sampleInput = draft.sample.trim() ? JSON.parse(draft.sample) : {};
      const app = await api("/api/apps", {
        method: "POST",
        body: JSON.stringify({
          name: draft.name,
          description: draft.description,
          requirements: draft.requirements,
          sampleInput,
          runtime: draft.runtime,
          language: draft.language,
        }),
      });
      await api(`/api/apps/${app.id}/generate`, { method: "POST", body: "{}" });
      toast("程序已生成并完成编译。", "success");
      await refresh();
      navigate(`/apps/${app.id}/requirements`);
    } catch (e) {
      toast(e.message, "error");
    }
  };
  const generateSample = async () => {
    if (!draft.description.trim()) {
      toast("请先填写需求描述，再生成示例输入。", "error");
      return;
    }
    toast("正在基于需求生成示例输入…", "info");
    try {
      const { input } = await api("/api/sample-input", {
        method: "POST",
        body: JSON.stringify({
          description: draft.description,
          runtime: draft.runtime,
        }),
      });
      setDraft((prev) => ({ ...prev, sample: JSON.stringify(input, null, 2) }));
      toast("示例输入已生成。", "success");
    } catch (e) {
      toast(e.message, "error");
    }
  };
  return (
    <Create
      draft={draft}
      setDraft={setDraft}
      create={create}
      generateSample={generateSample}
    />
  );
}

// ── AppEditorPage ───────────────────────────────────────────────────────────
function AppEditorPage() {
  const { id, tab } = useParams();
  const { apps, refresh, toast } = useLayout();
  const navigate = useNavigate();
  const app = useMemo(() => apps.find((a) => a.id === id), [apps, id]);
  useEffect(() => {
    if (!app && apps.length > 0) {
      navigate("/", { replace: true });
    }
  }, [app, apps.length, navigate]);
  if (!app) return <div className="tab-content">Loading…</div>;
  return (
    <Editor
      app={app}
      refresh={refresh}
      toast={toast}
      initialTab={tab || "requirements"}
    />
  );
}

// ── StatsPage ───────────────────────────────────────────────────────────────
function StatsPage() {
  const { stats, toast } = useLayout();
  const [localStats, setLocalStats] = useState(stats);
  useEffect(() => {
    setLocalStats(stats);
  }, [stats]);
  return (
    <StatsView
      stats={localStats}
      refresh={() =>
        api("/api/stats")
          .then(setLocalStats)
          .catch(() => toast("Failed to load stats", "error"))
      }
    />
  );
}

// ── Router App ──────────────────────────────────────────────────────────────
function RouterApp() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<AppsPage />} />
          <Route path="new" element={<NewAppPage />} />
          <Route path="stats" element={<StatsPage />} />
          <Route path="apps/:id/:tab?" element={<AppEditorPage />} />
        </Route>
        {/* Runtime page — no admin shell, standalone */}
        <Route path="app/:code" element={<RuntimePage />} />
      </Routes>
    </BrowserRouter>
  );
}

function AppList({ apps, open, create }) {
  const [search, setSearch] = useState("");
  const filtered = search.trim()
    ? apps.filter((a) => {
        const q = search.toLowerCase();
        return (
          a.name.toLowerCase().includes(q) ||
          a.description?.toLowerCase().includes(q) ||
          a.code?.toLowerCase().includes(q)
        );
      })
    : apps;
  return (
    <section className="page">
      <div className="toolbar">
        <p>管理、运行和发布你的自动化程序。</p>
        <div className="toolbar-right">
          <input
            className="search-input"
            placeholder="搜索程序…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button onClick={create}>+ 创建程序</button>
        </div>
      </div>
      <div className="cards">
        {filtered.map((app) => (
          <button className="card" key={app.id} onClick={() => open(app.id)}>
            <div className="card-top">
              <span className="runtime">{app.runtime || "javascript"}</span>
              <span className={app.publishedVersionId ? "live" : "draft"}>
                {app.publishedVersionId ? "LIVE" : "DRAFT"}
              </span>
            </div>
            <h2>{app.name}</h2>
            <p>{app.description}</p>
            <footer>
              <code>{app.code || app.id}</code>
              <span>{app.runs?.length || 0} runs</span>
            </footer>
          </button>
        ))}
        {!filtered.length && (
          <div className="empty">
            {search ? "没有匹配的程序。" : "还没有程序。"}
            {!search && <button onClick={create}>创建第一个</button>}
          </div>
        )}
      </div>
    </section>
  );
}
function Create({ draft, setDraft, create, generateSample }) {
  return (
    <section className="page form-page">
      <p className="lead">
        以需求文档为核心，描述你的小程序目标。Hosta 会生成代码、测试用例和输入
        Schema。
      </p>
      <form onSubmit={create}>
        <label>
          程序名称
          <input
            required
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="例如：订单汇总"
          />
        </label>
        <label>
          需求文档
          <span className="label-hint">
            小程序最稳定的资产，LLM 据此生成代码与测试
          </span>
          <textarea
            className="requirements-editor"
            value={draft.requirements}
            onChange={(e) =>
              setDraft({ ...draft, requirements: e.target.value })
            }
            placeholder={`# 程序需求文档

## 功能描述
详细描述这个程序要做什么...

## 输入格式
定义输入数据的结构和字段含义...

## 输出格式
定义期望的输出结构...

## 边界条件
- 输入为空时如何处理
- 输入数据量过大时如何处理

## 外部依赖
- 是否需要 ctx.call 调用其他程序
- 是否需要 ctx.fetch 访问外部 API`}
            rows={8}
          />
        </label>
        <label>
          一句话描述
          <span className="label-hint">摘要，用于列表展示和 LLM 提示</span>
          <input
            required
            value={draft.description}
            onChange={(e) =>
              setDraft({ ...draft, description: e.target.value })
            }
            placeholder="输入 items 数组，返回总金额。"
          />
        </label>
        <label>
          运行时
          <div className="segmented">
            <button
              type="button"
              className={draft.runtime === "javascript" ? "chosen" : ""}
              onClick={() => setDraft({ ...draft, runtime: "javascript" })}
            >
              JavaScript <small>适合 JSON、API 逻辑</small>
            </button>
            <button
              type="button"
              className={draft.runtime === "wasm" ? "chosen" : ""}
              onClick={() => setDraft({ ...draft, runtime: "wasm" })}
            >
              WebAssembly <small>通过系统编译 Rust 或 MoonBit</small>
            </button>
          </div>
        </label>
        {draft.runtime === "wasm" && (
          <label>
            WASM 源语言
            <div className="segmented">
              <button
                type="button"
                className={draft.language === "rust" ? "chosen" : ""}
                onClick={() => setDraft({ ...draft, language: "rust" })}
              >
                Rust <small>wasm32-unknown-unknown</small>
              </button>
              <button
                type="button"
                className={draft.language === "moonbit" ? "chosen" : ""}
                onClick={() => setDraft({ ...draft, language: "moonbit" })}
              >
                MoonBit <small>moon build --target wasm</small>
              </button>
            </div>
          </label>
        )}
        <label>
          需求
          <textarea
            required
            value={draft.description}
            onChange={(e) =>
              setDraft({ ...draft, description: e.target.value })
            }
            placeholder="输入 items 数组，返回总金额。"
          />
        </label>
        <label>
          示例输入
          <span className="label-hint">
            帮助 LLM 理解数据格式，可后续在 Schema 面板中精确定义
          </span>
          <div className="sample-tools">
            <button type="button" className="ghost" onClick={generateSample}>
              ✨ 基于需求生成
            </button>
            {draft.sample ? (
              <button
                type="button"
                className="ghost"
                onClick={() => setDraft({ ...draft, sample: "" })}
              >
                清空
              </button>
            ) : null}
          </div>
          <textarea
            className="code"
            value={draft.sample}
            onChange={(e) => setDraft({ ...draft, sample: e.target.value })}
          />
        </label>
        <button className="primary">生成程序</button>
      </form>
    </section>
  );
}
function Editor({ app, refresh, toast, initialTab }) {
  const version = app.draftVersion;
  const navigate = useNavigate();
  const runtime = version?.runtime || app.runtime || "javascript";
  const language = version?.language || app.language || "javascript";
  const tab = initialTab || "requirements";
  const [code, setCode] = useState(
    runtime === "wasm" ? version?.sourceCode || "" : version?.code || "",
  );
  const [input, setInput] = useState(
    JSON.stringify(app.sampleInput || {}, null, 2),
  );
  const [result, setResult] = useState("");
  const [deployment, setDeployment] = useState(null);
  const [slugDraft, setSlugDraft] = useState("");
  useEffect(() => {
    setCode(
      runtime === "wasm" ? version?.sourceCode || "" : version?.code || "",
    );
    setInput(JSON.stringify(app.sampleInput || {}, null, 2));
    setResult("");
    setSlugDraft(String(app.code || "").replace(/^\d+-/, ""));
  }, [app.id, version?.id]);
  const run = async (route) => {
    try {
      const value = await api(route, { method: "POST", body: input });
      setResult(JSON.stringify(value, null, 2));
    } catch (e) {
      setResult(`Error: ${e.message}`);
    }
  };
  const save = async () => {
    try {
      const v = await api(`/api/apps/${app.id}/versions`, {
        method: "POST",
        body: JSON.stringify({ code, runtime, language }),
      });
      toast(
        runtime === "wasm"
          ? `Rust/MoonBit 已编译，保存为 v${v.number}`
          : `已保存 v${v.number}`,
        "success",
      );
      await refresh();
    } catch (e) {
      toast(e.message, "error");
    }
  };
  const format = async () => {
    try {
      const { formatted } = await api("/api/format", {
        method: "POST",
        body: JSON.stringify({ code, runtime, language }),
      });
      setCode(formatted);
      toast("代码已格式化。", "success");
    } catch (e) {
      toast(e.message, "error");
    }
  };
  const publish = async () => {
    try {
      const r = await api(`/api/apps/${app.id}/publish`, {
        method: "POST",
        body: JSON.stringify({ versionId: version.id }),
      });
      setDeployment(r);
      toast("已发布。请立即保存此访问密钥。", "success");
      await refresh();
    } catch (e) {
      toast(e.message, "error");
    }
  };
  const remove = async () => {
    if (!confirm(`删除"${app.name}"及其所有版本、运行记录和部署？`)) return;
    try {
      await api(`/api/apps/${app.id}`, { method: "DELETE" });
      toast(`已删除 ${app.name}`, "success");
      navigate("/");
      await refresh();
    } catch (e) {
      toast(e.message, "error");
    }
  };
  const updateSlug = async () => {
    try {
      const updated = await api(`/api/apps/${app.id}`, {
        method: "PATCH",
        body: JSON.stringify({ code: slugDraft }),
      });
      setSlugDraft(String(updated.code || "").replace(/^\d+-/, ""));
      toast(`编码已更新为 ${updated.code}`, "success");
      await refresh();
    } catch (e) {
      toast(e.message, "error");
    }
  };
  const fileName =
    runtime === "wasm"
      ? language === "moonbit"
        ? "main.mbt"
        : "main.rs"
      : "index.js";
  const invokeUrl = `${location.origin}/invoke/${app.code}`;
  const sampleJson = JSON.stringify(app.sampleInput || {}, null, 0);
  const getUrl = `${invokeUrl}?key=${deployment ? deployment.webhookKey : "<KEY>"}&input=${encodeURIComponent(sampleJson)}`;
  const curlCmd = `curl -X POST ${invokeUrl} -H "Authorization: Bearer ${deployment ? deployment.webhookKey : "<KEY>"}" -H "Content-Type: application/json" -d '${sampleJson}'`;
  const tabs = [
    { key: "requirements", label: "需求文档" },
    {
      key: "tests",
      label: `测试用例${version?.tests?.length ? ` (${version.tests.length})` : ""}`,
    },
    { key: "schema", label: "输入 Schema" },
    { key: "datasource", label: "数据源" },
    { key: "code", label: "代码编辑器" },
    {
      key: "runs",
      label: `运行记录${app.runs?.length ? ` (${app.runs.length})` : ""}`,
    },
    { key: "versions", label: "版本管理" },
    { key: "pages", label: "页面配置" },
    { key: "docs", label: "调用文档" },
  ];
  return (
    <section className="editor-page">
      <div className="editor-head">
        <div>
          <span className="status-ready">{version?.status || "draft"}</span>
          <span>
            v{version?.number || 0} · {runtime}
            {runtime === "wasm" ? ` / ${language}` : ""}
          </span>
        </div>
        <div>
          <button className="danger" onClick={remove}>
            删除程序
          </button>
          <button className="ghost" onClick={format}>
            格式化
          </button>
          <button className="ghost" onClick={save}>
            编译并保存
          </button>
          <button onClick={publish}>发布</button>
        </div>
      </div>
      <div className="tab-bar">
        {tabs.map((t) => (
          <NavLink
            key={t.key}
            to={`/apps/${app.id}/${t.key}`}
            className={({ isActive }) => `tab-btn${isActive ? " active" : ""}`}
          >
            {t.label}
          </NavLink>
        ))}
      </div>
      {tab === "code" && (
        <CodePanel
          code={code}
          setCode={setCode}
          input={input}
          setInput={setInput}
          result={result}
          run={run}
          version={version}
          runtime={runtime}
          language={language}
          fileName={fileName}
        />
      )}
      {tab === "requirements" && (
        <RequirementsPanel
          app={app}
          version={version}
          toast={toast}
          refresh={refresh}
        />
      )}
      {tab === "tests" && (
        <TestPanel
          version={version}
          app={app}
          toast={toast}
          refresh={refresh}
        />
      )}
      {tab === "schema" && (
        <SchemaPanel
          version={version}
          app={app}
          toast={toast}
          refresh={refresh}
        />
      )}
      {tab === "datasource" && (
        <DatasourcePanel app={app} toast={toast} refresh={refresh} />
      )}
      {tab === "runs" && <RunsPanel app={app} />}
      {tab === "versions" && (
        <VersionPanel app={app} toast={toast} refresh={refresh} />
      )}
      {tab === "pages" && (
        <PagesPanel app={app} toast={toast} refresh={refresh} />
      )}
      {tab === "docs" && (
        <DocsPanel
          app={app}
          deployment={deployment}
          slugDraft={slugDraft}
          setSlugDraft={setSlugDraft}
          updateSlug={updateSlug}
          getUrl={getUrl}
          curlCmd={curlCmd}
        />
      )}
    </section>
  );
}
function CodePanel({
  code,
  setCode,
  input,
  setInput,
  result,
  run,
  version,
  runtime,
  language,
  fileName,
}) {
  // 解析诊断结果中的质量评分
  let quality = null;
  try {
    const parsed = JSON.parse(result);
    if (parsed.quality) quality = parsed.quality;
  } catch {}
  return (
    <div className="editor-grid">
      <div className="panel code-panel">
        <div className="panel-title">
          <span>{fileName}</span>
          <span>
            {runtime === "wasm"
              ? `系统 ${language === "moonbit" ? "moon build --target wasm" : "rustc --target wasm32-unknown-unknown"}`
              : "编辑器"}
          </span>
        </div>
        <textarea
          className="code-editor"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          spellCheck="false"
          placeholder={
            runtime === "wasm"
              ? language === "moonbit"
                ? moonStarter
                : rustStarter
              : emptyJs
          }
        />
      </div>
      <div className="panel runner">
        <div className="panel-title">
          <span>请求</span>
          <span className="runner-actions">
            <button
              className="text-btn"
              onClick={() => run(`/api/versions/${version.id}/run`)}
            >
              运行 ▶
            </button>
            <button
              className="text-btn"
              onClick={() => run(`/api/versions/${version.id}/diagnose`)}
            >
              诊断
            </button>
          </span>
        </div>
        <textarea
          className="code-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          spellCheck="false"
        />
        <div className="panel-title">
          <span>结果与诊断</span>
          {quality && (
            <span
              className={`quality-score quality-${Math.round(quality.score)}`}
            >
              代码质量：{quality.score}/{quality.maxScore}
              {quality.details?.map((d, i) => (
                <span key={i} className="quality-detail" title={d.reason}>
                  {d.passed ? "✓" : "✗"}
                  {d.label}
                </span>
              ))}
            </span>
          )}
        </div>
        <pre>
          {result ||
            (runtime === "wasm"
              ? "保存时会编译源码；运行使用保存的 WASM 二进制。"
              : "运行程序或选择诊断以查看结果。")}
        </pre>
      </div>
    </div>
  );
}
function RequirementsPanel({ app, version, toast, refresh }) {
  const [requirements, setRequirements] = useState(app.requirements || "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);

  useEffect(() => {
    setRequirements(app.requirements || "");
    setSaved(false);
  }, [app.id]);

  const saveRequirements = async () => {
    setSaving(true);
    try {
      const updated = await api(`/api/apps/${app.id}`, {
        method: "PATCH",
        body: JSON.stringify({ requirements }),
      });
      setRequirements(updated.requirements || "");
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      await refresh();
    } catch (e) {
      toast(e.message, "error");
    } finally {
      setSaving(false);
    }
  };

  const hasRequirements = requirements.trim().length > 0;

  return (
    <div className="tab-content">
      {/* ── Toolbar ── */}
      <div className="req-toolbar">
        <div className="req-toolbar__left">
          <span className="panel-title" style={{ marginBottom: 0 }}>
            需求文档
          </span>
          <span className="subtitle">
            小程序最稳定的资产。描述业务逻辑、数据格式、边界条件，LLM
            据此生成代码和测试。
          </span>
        </div>
        <div className="req-toolbar__actions">
          <span className={`req-save-status ${saved ? "req-saved" : ""}`}>
            {saved ? "✓ 已保存" : hasRequirements ? "已修改" : ""}
          </span>
          <button
            className="ghost"
            onClick={saveRequirements}
            disabled={saving}
          >
            {saving ? "保存中…" : "💾 保存"}
          </button>
          <button className="primary" onClick={() => setAiOpen(true)}>
            🤖 AI 优化
          </button>
        </div>
      </div>

      {/* ── 主编辑器 ── */}
      <textarea
        className="requirements-editor"
        value={requirements}
        onChange={(e) => {
          setRequirements(e.target.value);
          setSaved(false);
        }}
        placeholder={`# 程序需求文档

## 功能描述
详细描述这个程序要做什么...

## 输入格式
定义输入数据的结构和字段含义...

## 输出格式
定义期望的输出结构...

## 边界条件
- 输入为空时如何处理
- 输入数据量过大时如何处理
- 特殊字符处理...

## 外部依赖
- 是否需要调用其他程序（ctx.call）
- 是否需要访问外部 API（ctx.fetch）

## 示例
描述几个典型的使用场景...`}
        spellCheck={false}
      />

      {/* ── AI Drawer ── */}
      <AIDrawer
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        title="优化需求文档"
        goal="根据你的指令，对需求文档进行结构化优化。补充边界条件、明确输入输出格式、添加示例。"
        context={requirements}
        placeholder="例如：补充空数组输入的处理逻辑；增加错误码说明；用更结构化方式描述输出格式…"
        onGenerate={async (instruction) => {
          const res = await api(`/api/apps/${app.id}/refine-requirements`, {
            method: "POST",
            body: JSON.stringify({ instruction }),
          });
          return { summary: res.summary, result: res.refined };
        }}
        onApply={(_, refinedText) => {
          setRequirements(refinedText);
          setSaved(false);
          toast("已应用 AI 优化结果，请保存。", "success");
        }}
      />
    </div>
  );
}
function SchemaPanel({ version, app, toast, refresh }) {
  const currentInput = version?.inputSchema;
  const currentOutput = version?.outputSchema;
  const [inputText, setInputText] = useState(
    currentInput
      ? JSON.stringify(currentInput, null, 2)
      : '{\n  "type": "object",\n  "properties": {},\n  "required": []\n}',
  );
  const [outputText, setOutputText] = useState(
    currentOutput
      ? JSON.stringify(currentOutput, null, 2)
      : '{\n  "type": "object",\n  "properties": {},\n  "required": []\n}',
  );
  const [inputError, setInputError] = useState(null);
  const [outputError, setOutputError] = useState(null);
  const [aiSchemaOpen, setAiSchemaOpen] = useState(false);
  const [aiSchemaTarget, setAiSchemaTarget] = useState("input");
  useEffect(() => {
    setInputText(
      currentInput
        ? JSON.stringify(currentInput, null, 2)
        : '{\n  "type": "object",\n  "properties": {},\n  "required": []\n}',
    );
    setOutputText(
      currentOutput
        ? JSON.stringify(currentOutput, null, 2)
        : '{\n  "type": "object",\n  "properties": {},\n  "required": []\n}',
    );
    setInputError(null);
    setOutputError(null);
  }, [version?.id]);
  const parseJSON = (text, setError) => {
    try {
      const p = JSON.parse(text);
      if (!p || typeof p !== "object") throw new Error("Must be object");
      setError(null);
      return p;
    } catch (e) {
      setError(e.message);
      return null;
    }
  };
  const saveSchema = async () => {
    const inp = parseJSON(inputText, setInputError);
    const out = parseJSON(outputText, setOutputError);
    if (!inp) {
      toast("输入 Schema JSON 格式错误", "error");
      return;
    }
    if (!out && !currentOutput && !outputText.trim()) {
      /* ok empty */
    }
    try {
      const res = await api(`/api/versions/${version.id}/schema`, {
        method: "PUT",
        body: JSON.stringify({ inputSchema: inp, outputSchema: out || null }),
      });
      toast("Schema 已保存", "success");
      setInputText(JSON.stringify(res.inputSchema, null, 2));
      if (res.outputSchema)
        setOutputText(JSON.stringify(res.outputSchema, null, 2));
      await refresh();
    } catch (e) {
      toast(e.message, "error");
    }
  };
  const inferFromTests = (target) => {
    const tests = version?.tests || [];
    if (!tests.length) {
      toast("暂无测试用例，无法推断", "info");
      return;
    }
    const key = target === "input" ? "input" : "expectedOutput";
    const props = {};
    const required = [];
    const total = tests.filter(
      (t) => t[key] && typeof t[key] === "object",
    ).length;
    for (const t of tests) {
      const obj = t[key];
      if (!obj || typeof obj !== "object") continue;
      for (const [k, val] of Object.entries(obj)) {
        if (!props[k]) props[k] = { type: typeof val };
      }
    }
    for (const [k] of Object.entries(props)) {
      const count = tests.filter(
        (t) => t[key] && typeof t[key] === "object" && k in t[key],
      ).length;
      if (count >= total && total > 0) required.push(k);
    }
    const newSchema = { type: "object", properties: props };
    if (required.length) newSchema.required = required;
    const text = JSON.stringify(newSchema, null, 2);
    if (target === "input") {
      setInputText(text);
      setInputError(null);
    } else {
      setOutputText(text);
      setOutputError(null);
    }
    toast(
      `已从 ${tests.length} 个测试用例推断${target === "input" ? "输入" : "输出"} schema`,
      "success",
    );
  };
  const clearSchema = async (target) => {
    if (!confirm(`确定清空${target === "input" ? "输入" : "输出"} Schema？`))
      return;
    try {
      const payload =
        target === "input"
          ? { inputSchema: { type: "object", properties: {}, required: [] } }
          : {
              inputSchema: currentInput || {
                type: "object",
                properties: {},
                required: [],
              },
              outputSchema: null,
            };
      await api(`/api/versions/${version.id}/schema`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      if (target === "input")
        setInputText(
          '{\n  "type": "object",\n  "properties": {},\n  "required": []\n}',
        );
      else
        setOutputText(
          '{\n  "type": "object",\n  "properties": {},\n  "required": []\n}',
        );
      toast(`${target === "input" ? "输入" : "输出"} Schema 已清空`, "success");
      await refresh();
    } catch (e) {
      toast(e.message, "error");
    }
  };
  const openAiSchema = (target) => {
    setAiSchemaTarget(target);
    setAiSchemaOpen(true);
  };
  const hasInput =
    currentInput &&
    currentInput.properties &&
    Object.keys(currentInput.properties).length > 0;
  const hasOutput =
    currentOutput &&
    currentOutput.properties &&
    Object.keys(currentOutput.properties).length > 0;
  return (
    <div className="tab-content">
      <div className="schema-grid">
        <div className="schema-col">
          <div className="panel-title">
            <span>输入 JSON Schema</span>
            <span className="subtitle">
              定义小程序接收的输入数据格式。运行时和测试用例添加时校验。
            </span>
          </div>
          <div className="schema-toolbar">
            <button className="text-btn" onClick={saveSchema}>
              💾 保存全部
            </button>
            <button
              className="text-btn"
              onClick={() => inferFromTests("input")}
            >
              从测试推断
            </button>
            <button className="text-btn" onClick={() => openAiSchema("input")}>
              🤖 AI 生成
            </button>
            <button
              className="text-btn danger"
              onClick={() => clearSchema("input")}
              disabled={!hasInput}
            >
              清空
            </button>
          </div>
          {inputError && (
            <div className="schema-error">JSON 格式错误：{inputError}</div>
          )}
          <textarea
            className="schema-editor"
            value={inputText}
            onChange={(e) => {
              setInputText(e.target.value);
              setInputError(null);
            }}
            spellCheck={false}
          />
        </div>
        <div className="schema-col">
          <div className="panel-title">
            <span>输出 JSON Schema</span>
            <span className="subtitle">
              定义小程序的输出数据格式。用于测试校验和接口文档。
            </span>
          </div>
          <div className="schema-toolbar">
            <button
              className="text-btn"
              onClick={() => inferFromTests("output")}
            >
              从测试推断
            </button>
            <button className="text-btn" onClick={() => openAiSchema("output")}>
              🤖 AI 生成
            </button>
            <button
              className="text-btn danger"
              onClick={() => clearSchema("output")}
              disabled={!hasOutput}
            >
              清空
            </button>
          </div>
          {outputError && (
            <div className="schema-error">JSON 格式错误：{outputError}</div>
          )}
          <textarea
            className="schema-editor"
            value={outputText}
            onChange={(e) => {
              setOutputText(e.target.value);
              setOutputError(null);
            }}
            spellCheck={false}
          />
        </div>
      </div>
      <details className="schema-help">
        <summary>JSON Schema 语法参考</summary>
        <pre className="schema-help-text">{`{
  "type": "object",
  "properties": {
    "name": { "type": "string", "minLength": 1 },
    "age": { "type": "integer", "minimum": 0 },
    "tags": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["name"],
  "additionalProperties": false
}`}</pre>
      </details>

      {/* ── AI 生成 Schema Drawer ── */}
      <AIDrawer
        open={aiSchemaOpen}
        onClose={() => setAiSchemaOpen(false)}
        title={`生成${aiSchemaTarget === "input" ? "输入" : "输出"} Schema`}
        goal={`根据「${app.name}」的需求文档、代码和测试用例，生成${aiSchemaTarget === "input" ? "输入" : "输出"} JSON Schema。`}
        context={`程序：${app.name}\n描述：${app.description || "N/A"}\n需求：${app.requirements || "N/A"}\n代码：${version?.code?.slice(0, 300) || "无"}\n测试用例数：${version?.tests?.length || 0}`}
        placeholder={`描述 Schema 的额外要求…（如：所有字段必填、age 字段需大于 0）`}
        applyLabel="✓ 填入编辑器"
        onGenerate={async (instruction) => {
          const { schema } = await api(
            `/api/versions/${version.id}/schema/generate`,
            {
              method: "POST",
              body: JSON.stringify({
                target: aiSchemaTarget,
                instruction,
              }),
            },
          );
          return {
            summary: `已生成 ${Object.keys(schema?.properties || {}).length} 个字段`,
            result: JSON.stringify(schema, null, 2),
          };
        }}
        onApply={(_, result) => {
          if (aiSchemaTarget === "input") {
            setInputText(result);
            setInputError(null);
          } else {
            setOutputText(result);
            setOutputError(null);
          }
          toast(
            `${aiSchemaTarget === "input" ? "输入" : "输出"} Schema 已填入编辑器，请检查后保存。`,
            "success",
          );
        }}
      />
    </div>
  );
}
function TestPanel({ version, app, toast, refresh }) {
  const [tests, setTests] = useState([]);
  const [testResults, setTestResults] = useState(null);
  const [running, setRunning] = useState(false);
  const [generating, setGenerating] = useState(false);
  // ── add modal state ──
  const [addOpen, setAddOpen] = useState(false);
  const [testName, setTestName] = useState("");
  const [testInput, setTestInput] = useState("{\n  \n}");
  const [testOutput, setTestOutput] = useState("");
  // ── AI drawer states ──
  const [aiReviseOpen, setAiReviseOpen] = useState(false);
  const [aiTestGenOpen, setAiTestGenOpen] = useState(false);

  useEffect(() => {
    setTests(version?.tests || []);
    setTestResults(null);
  }, [version?.id]);

  const openAdd = () => {
    setAddOpen(true);
    setTestName("");
    setTestInput("{\n  \n}");
    setTestOutput("");
  };

  const addTest = async () => {
    try {
      const parsed = JSON.parse(testInput);
      const expectedOutput = testOutput.trim()
        ? JSON.parse(testOutput)
        : undefined;
      await api(`/api/versions/${version.id}/tests`, {
        method: "POST",
        body: JSON.stringify({
          name: testName || undefined,
          input: parsed,
          expectedOutput,
        }),
      });
      toast("测试用例已添加。", "success");
      setAddOpen(false);
      await refresh();
    } catch (e) {
      toast(e.message, "error");
    }
  };

  const removeTest = async (idx) => {
    try {
      await api(`/api/versions/${version.id}/tests/${idx}`, {
        method: "DELETE",
      });
      setTests((prev) => prev.filter((_, i) => i !== idx));
      toast("测试用例已删除。", "success");
    } catch (e) {
      toast(e.message, "error");
    }
  };

  const runAllTests = async () => {
    setRunning(true);
    setTestResults(null);
    try {
      const data = await api(`/api/versions/${version.id}/tests/run-all`, {
        method: "POST",
      });
      setTestResults(data);
      toast(
        `测试完成：${data.passed}/${data.total} 通过`,
        data.passed === data.total ? "success" : "error",
      );
    } catch (e) {
      toast(e.message, "error");
    }
    setRunning(false);
  };

  const runSingleTest = async (idx) => {
    setRunning(true);
    try {
      const test = tests[idx];
      const runResult = await api(`/api/versions/${version.id}/run`, {
        method: "POST",
        body: JSON.stringify(test.input),
      });
      const matched = test.expectedOutput
        ? JSON.stringify(runResult.result) ===
          JSON.stringify(test.expectedOutput)
        : undefined;
      setTestResults({
        versionId: version.id,
        passed: runResult.status === "succeeded" ? 1 : 0,
        total: 1,
        results: [
          {
            name: test.name,
            input: test.input,
            expectedOutput: test.expectedOutput,
            actualStatus: runResult.status,
            matched,
            runId: runResult.id,
            durationMs: runResult.durationMs,
            result: runResult.result,
            error: runResult.error,
          },
        ],
      });
      toast(
        `测试${runResult.status === "succeeded" ? "通过" : "失败"} · ${runResult.durationMs}ms`,
        runResult.status === "succeeded" ? "success" : "error",
      );
    } catch (e) {
      toast(e.message, "error");
    }
    setRunning(false);
  };

  const failedCount = testResults ? testResults.total - testResults.passed : 0;
  const failedTests =
    testResults?.results?.filter((r) => r.actualStatus !== "succeeded") || [];

  // build context for AI revise drawer
  const reviseContext =
    failedTests.length > 0
      ? failedTests
          .map(
            (r, i) =>
              `## 失败 #{i + 1}: ${r.name || ""}\n输入: ${JSON.stringify(r.input)}\n期望: ${JSON.stringify(r.expectedOutput)}\n实际: ${r.error ? r.error.message : JSON.stringify(r.result)}`,
          )
          .join("\n\n")
      : "";

  return (
    <div className="tab-content">
      {/* ── Toolbar ── */}
      <div className="test-toolbar">
        <div className="test-toolbar__left">
          <span className="panel-title" style={{ marginBottom: 0 }}>
            测试用例（{tests.length} 组）
          </span>
          <span className="subtitle">
            验证程序功能的输入-输出对。建议至少 3 组涵盖正常、边界、异常场景。
          </span>
        </div>
        <div className="test-toolbar__actions">
          <button className="ghost" onClick={openAdd}>
            + 手动添加
          </button>
          <button
            className="ghost"
            onClick={() => setAiTestGenOpen(true)}
            disabled={running}
          >
            ✨ 生成测试
          </button>
          <button
            className="primary"
            onClick={runAllTests}
            disabled={running || !tests.length}
          >
            {running ? "运行中…" : "▶ 全部运行"}
          </button>
        </div>
      </div>

      {/* ── 测试结果 ── */}
      {testResults && (
        <div
          className={`test-result-bar ${failedCount > 0 ? "test-result-bar--fail" : "test-result-bar--ok"}`}
        >
          <span
            className={`test-summary ${testResults.passed === testResults.total ? "passed" : "failed"}`}
          >
            {testResults.passed}/{testResults.total} 通过
          </span>
          <button className="primary" onClick={() => setAiReviseOpen(true)}>
            🤖 AI 修订
          </button>
        </div>
      )}

      {/* ── 测试列表（全宽） ── */}
      <div className="test-list-full">
        {tests.length === 0 ? (
          <div className="empty-hint">
            暂无测试用例。点击「✨ 生成测试」让 LLM 自动生成，或「+
            手动添加」自定义测试。
          </div>
        ) : (
          tests.map((test, idx) => (
            <div key={idx} className="test-item">
              <div className="test-item-head">
                <span className="test-idx">#{idx + 1}</span>
                <span className="test-name">
                  {test.name || `测试 ${idx + 1}`}
                </span>
                <button
                  className="text-btn"
                  onClick={() => runSingleTest(idx)}
                  disabled={running}
                >
                  ▶ 运行
                </button>
                <button
                  className="text-btn danger"
                  onClick={() => removeTest(idx)}
                >
                  删除
                </button>
              </div>
              <div className="test-io-pair">
                <div className="test-io">
                  <span className="test-io-label">输入</span>
                  <pre className="test-input-preview">
                    {JSON.stringify(test.input, null, 2)}
                  </pre>
                </div>
                {test.expectedOutput && (
                  <div className="test-io">
                    <span className="test-io-label">期望输出</span>
                    <pre className="test-input-preview">
                      {JSON.stringify(test.expectedOutput, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* ── 测试结果详情 ── */}
      {testResults && testResults.results?.length > 0 && (
        <div className="test-results-detail">
          <div className="panel-title">
            <span>结果详情</span>
          </div>
          {testResults.results.map((r, idx) => (
            <div
              key={idx}
              className={`test-result-card ${r.actualStatus === "succeeded" ? "result-ok" : "result-fail"}`}
            >
              <div className="test-result-head">
                <span>
                  #{idx + 1} {r.name || ""}{" "}
                  {r.actualStatus === "succeeded" ? "✓ 通过" : "✗ 失败"}
                  {r.matched !== undefined &&
                    (r.matched ? " 🎯 匹配" : " ⚠ 输出不匹配")}
                </span>
                <span>{r.durationMs}ms</span>
              </div>
              {r.error && <pre className="test-error">{r.error.message}</pre>}
              {r.result && (
                <pre className="test-output">
                  {JSON.stringify(r.result, null, 2)}
                </pre>
              )}
              {r.expectedOutput && (
                <div className="test-expected">
                  <span className="test-io-label">期望输出</span>
                  <pre className="test-output">
                    {JSON.stringify(r.expectedOutput, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── 手动添加 Modal ── */}
      {addOpen && (
        <div className="modal-overlay" onClick={() => setAddOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal__header">
              <h3>手动添加测试用例</h3>
              <button className="ghost" onClick={() => setAddOpen(false)}>
                ✕
              </button>
            </div>
            <div className="modal__body">
              <label className="test-field-label">名称</label>
              <input
                className="test-name-input"
                value={testName}
                onChange={(e) => setTestName(e.target.value)}
                placeholder="例如：空数组输入"
              />
              <label className="test-field-label">输入 JSON</label>
              <textarea
                className="code-input"
                value={testInput}
                onChange={(e) => setTestInput(e.target.value)}
                spellCheck="false"
                placeholder='{"key": "value"}'
              />
              <label className="test-field-label">期望输出 JSON（可选）</label>
              <textarea
                className="code-input"
                value={testOutput}
                onChange={(e) => setTestOutput(e.target.value)}
                spellCheck="false"
                placeholder='{"ok": true}'
              />
            </div>
            <div className="modal__footer">
              <button className="ghost" onClick={() => setAddOpen(false)}>
                取消
              </button>
              <button onClick={addTest} disabled={!testInput.trim()}>
                + 添加测试用例
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── AI 修订 Drawer ── */}
      <AIDrawer
        open={aiReviseOpen}
        onClose={() => setAiReviseOpen(false)}
        title="修正代码"
        goal="根据失败的测试用例，修正代码逻辑，使所有测试通过。"
        context={reviseContext || "（无失败用例，可自由描述期望的改进方向）"}
        placeholder="告诉 AI 从哪个方向修正…（如：输出字段名应为 camelCase）"
        onGenerate={async (instruction) => {
          const data = await api(`/api/versions/${version.id}/revise`, {
            method: "POST",
            body: JSON.stringify({ hint: instruction }),
          });
          return {
            summary: `修订版本 v${data.version.number}`,
            result: data.version.summary,
          };
        }}
        onApply={async () => {
          toast("LLM 修订已生成新版本。", "success");
          await refresh();
        }}
        applyLabel="✓ 应用并刷新"
      />

      {/* ── AI 生成测试 Drawer ── */}
      <AIDrawer
        open={aiTestGenOpen}
        onClose={() => setAiTestGenOpen(false)}
        title="生成测试用例"
        goal={`根据「${app.name}」的需求，生成覆盖正常、边界、异常场景的测试用例。`}
        context={`程序：${app.name}\n${app.description ? `描述：${app.description}` : ""}\n已有测试：${tests.length} 组`}
        placeholder="告诉 AI 关注哪些场景…（可选）"
        onGenerate={async (instruction) => {
          setGenerating(true);
          try {
            const data = await api(
              `/api/versions/${version.id}/tests/generate`,
              { method: "POST", body: JSON.stringify({ instruction }) },
            );
            return {
              summary: `已生成 ${data.generated} 个测试用例`,
              result: data.generated,
            };
          } finally {
            setGenerating(false);
          }
        }}
        onApply={async () => {
          toast("测试用例已生成。", "success");
          await refresh();
        }}
        applyLabel="✓ 应用并刷新"
      />
    </div>
  );
}
function DatasourcePanel({ app, toast, refresh }) {
  const [subTab, setSubTab] = useState("internal");
  const [data, setData] = useState("");
  const [schema, setSchema] = useState("");
  const [schemaVisible, setSchemaVisible] = useState(true);
  const [snapshots, setSnapshots] = useState([]);
  const [migrationScript, setMigrationScript] = useState("");
  const [migrationResult, setMigrationResult] = useState(null);
  const [loading, setLoading] = useState(false);
  // ── Internal ──
  useEffect(() => {
    const ds = app.datasource || { data: {} };
    setData(JSON.stringify(ds.data, null, 2));
    setSchema(ds.schema ? JSON.stringify(ds.schema, null, 2) : "");
    setMigrationResult(null);
  }, [app.id, app.datasource?.updatedAt]);
  const loadSnapshots = async () => {
    try {
      const r = await api(`/api/apps/${app.id}/datasource/snapshots`);
      setSnapshots(r.snapshots || []);
    } catch (e) {
      toast(e.message, "error");
    }
  };
  useEffect(() => {
    loadSnapshots().catch(() => {});
  }, [app.id, app.datasource?.updatedAt]);
  const saveData = async () => {
    setLoading(true);
    try {
      const parsed = JSON.parse(data);
      const schemaParsed = schema.trim() ? JSON.parse(schema) : null;
      await api(`/api/apps/${app.id}/datasource`, {
        method: "PUT",
        body: JSON.stringify({ data: parsed, schema: schemaParsed }),
      });
      toast("数据源已保存（自动创建快照）。", "success");
      await refresh();
    } catch (e) {
      toast(e.message, "error");
    }
    setLoading(false);
  };
  const restoreSnapshot = async (snapshotId) => {
    if (!confirm("确认恢复到该快照？当前数据将被替换。")) return;
    try {
      const r = await api(
        `/api/apps/${app.id}/datasource/restore/${snapshotId}`,
        { method: "POST" },
      );
      setData(JSON.stringify(r.after, null, 2));
      toast("数据已从快照恢复。", "success");
      await refresh();
    } catch (e) {
      toast(e.message, "error");
    }
  };
  const runMigration = async () => {
    if (!migrationScript.trim()) {
      toast("请输入迁移脚本。", "error");
      return;
    }
    setLoading(true);
    setMigrationResult(null);
    try {
      const r = await api(`/api/apps/${app.id}/datasource/migrate`, {
        method: "POST",
        body: JSON.stringify({ script: migrationScript }),
      });
      setMigrationResult(r);
      toast("迁移脚本已执行，结果保存为待确认快照。", "success");
      await refresh();
    } catch (e) {
      setMigrationResult({ success: false, error: e.message, logs: [] });
    }
    setLoading(false);
  };
  const promoteSnapshot = async (snapshotId) => {
    if (!confirm("确认将此迁移结果应用为主版本数据源？")) return;
    setLoading(true);
    try {
      const r = await api(
        `/api/apps/${app.id}/datasource/promote/${snapshotId}`,
        { method: "POST" },
      );
      setData(JSON.stringify(r.after, null, 2));
      toast("迁移结果已应用为主版本。", "success");
      await refresh();
    } catch (e) {
      toast(e.message, "error");
    }
    setLoading(false);
  };
  const ds = app.datasource || { data: {}, updatedAt: null };
  const migrationStarter =
    "// 在当前数据上运行迁移脚本\n// 变量 data 是当前数据源对象的副本\n// 直接修改 data（如 data.newField = ...）\n// 迁移完成后，结果保存为待确认快照，需手动应用\n\ndata.totalCount = data.items ? data.items.length : 0;\ndata.migratedAt = new Date().toISOString();\n";

  // ── External ──
  const [extList, setExtList] = useState([]);
  const [editingExt, setEditingExt] = useState(null);
  const [extForm, setExtForm] = useState({
    name: "",
    url: "",
    method: "GET",
    headers: "{}",
    inputSchema: "",
    outputSchema: "",
  });
  const [extTestResult, setExtTestResult] = useState(null);
  const [extTestInput, setExtTestInput] = useState("{\n  \n}");
  useEffect(() => {
    setExtList(app.externalDatasources || []);
  }, [app.id, app.externalDatasources]);
  const resetExtForm = () => {
    setEditingExt(null);
    setExtForm({
      name: "",
      url: "",
      method: "GET",
      headers: "{}",
      inputSchema: "",
      outputSchema: "",
    });
    setExtTestResult(null);
  };
  const editExt = (eds) => {
    setEditingExt(eds.id);
    setExtForm({
      name: eds.name || "",
      url: eds.url || "",
      method: eds.method || "GET",
      headers: JSON.stringify(eds.headers || {}, null, 2),
      inputSchema: eds.inputSchema
        ? JSON.stringify(eds.inputSchema, null, 2)
        : "",
      outputSchema: eds.outputSchema
        ? JSON.stringify(eds.outputSchema, null, 2)
        : "",
    });
    setExtTestResult(null);
  };
  const saveExt = async () => {
    const headers = (() => {
      try {
        return JSON.parse(extForm.headers);
      } catch {
        toast("Headers 需为合法 JSON", "error");
        return null;
      }
    })();
    if (headers === null) return;
    const inputSchema = (() => {
      if (!extForm.inputSchema.trim()) return null;
      try {
        return JSON.parse(extForm.inputSchema);
      } catch {
        toast("输入 Schema 需为合法 JSON", "error");
        return null;
      }
    })();
    if (inputSchema === null && extForm.inputSchema.trim()) return;
    const outputSchema = (() => {
      if (!extForm.outputSchema.trim()) return null;
      try {
        return JSON.parse(extForm.outputSchema);
      } catch {
        toast("输出 Schema 需为合法 JSON", "error");
        return null;
      }
    })();
    if (outputSchema === null && extForm.outputSchema.trim()) return;
    try {
      if (editingExt) {
        await api(`/api/apps/${app.id}/external-datasources/${editingExt}`, {
          method: "PUT",
          body: JSON.stringify({
            name: extForm.name,
            url: extForm.url,
            method: extForm.method,
            headers,
            inputSchema,
            outputSchema,
          }),
        });
        toast("外部数据源已更新", "success");
      } else {
        await api(`/api/apps/${app.id}/external-datasources`, {
          method: "POST",
          body: JSON.stringify({
            name: extForm.name,
            url: extForm.url,
            method: extForm.method,
            headers,
            inputSchema,
            outputSchema,
          }),
        });
        toast("外部数据源已添加", "success");
      }
      resetExtForm();
      await refresh();
    } catch (e) {
      toast(e.message, "error");
    }
  };
  const deleteExt = async (edsId) => {
    if (!confirm("确认删除此外部数据源？")) return;
    try {
      await api(`/api/apps/${app.id}/external-datasources/${edsId}`, {
        method: "DELETE",
      });
      toast("外部数据源已删除", "success");
      if (editingExt === edsId) resetExtForm();
      await refresh();
    } catch (e) {
      toast(e.message, "error");
    }
  };
  const testExt = async (edsId) => {
    setExtTestResult(null);
    try {
      const input = extTestInput.trim() ? JSON.parse(extTestInput) : {};
      const r = await api(
        `/api/apps/${app.id}/external-datasources/${edsId}/test`,
        {
          method: "POST",
          body: JSON.stringify(input),
        },
      );
      setExtTestResult(r);
    } catch (e) {
      setExtTestResult({ error: e.message });
    }
  };
  const subTabs = [
    { key: "internal", label: "内部状态" },
    {
      key: "external",
      label: `外部数据${extList.length ? ` (${extList.length})` : ""}`,
    },
  ];
  return (
    <div className="tab-content">
      <div className="tab-bar">
        {subTabs.map((t) => (
          <button
            key={t.key}
            className={`tab-btn ${subTab === t.key ? "active" : ""}`}
            onClick={() => setSubTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {subTab === "internal" && (
        <div className="ds-layout">
          <div className="ds-editor-panel">
            <div className="panel-title">
              <span>内部状态数据</span>
              <span className="subtitle">
                {ds.updatedAt
                  ? `最后更新：${new Date(ds.updatedAt).toLocaleString()}`
                  : "尚未设置"}
              </span>
            </div>
            <textarea
              className="code-editor ds-data-editor"
              value={data}
              onChange={(e) => setData(e.target.value)}
              spellCheck="false"
              placeholder='{"users": [], "config": {}}'
            />
            <div className="ds-schema-toggle">
              <button
                className="link-btn"
                onClick={() => setSchemaVisible(!schemaVisible)}
              >
                {schemaVisible ? "▾" : "▸"} Schema 定义
                {schema.trim() ? " (已设置)" : " (可选，用于校验和 LLM 提示)"}
              </button>
            </div>
            {schemaVisible && (
              <div className="ds-schema-editor">
                <p className="test-hint">
                  定义 JSON Schema 来描述数据源的结构。保存数据时会自动校验，
                  代码生成时也会注入给 LLM 作为上下文。
                </p>
                <textarea
                  className="code-editor ds-schema-input"
                  value={schema}
                  onChange={(e) => setSchema(e.target.value)}
                  spellCheck="false"
                  placeholder={`{
  "type": "object",
  "properties": {
    "users": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "age": { "type": "integer" }
        }
      }
    }
  }
}`}
                />
              </div>
            )}
            <div className="ds-actions">
              <button onClick={saveData} disabled={loading}>
                💾 保存数据
              </button>
            </div>
          </div>
          <div className="ds-side">
            <div className="ds-migration-panel">
              <div className="panel-title">
                <span>迁移脚本</span>
              </div>
              <p className="test-hint">
                当业务需求导致数据结构变更时，编写 JavaScript
                迁移脚本直接修改数据。脚本中可直接访问 <code>data</code>{" "}
                变量（当前数据副本）。迁移结果保存为待确认快照，需手动应用。
              </p>
              <textarea
                className="code-input ds-migration-editor"
                value={migrationScript}
                onChange={(e) => setMigrationScript(e.target.value)}
                spellCheck="false"
                placeholder={migrationStarter}
              />
              <button
                onClick={runMigration}
                disabled={loading || !migrationScript.trim()}
              >
                {loading ? "执行中…" : "▶ 执行迁移"}
              </button>
              {migrationResult && (
                <div
                  className={`migration-result ${migrationResult.success ? "migration-ok" : "migration-fail"}`}
                >
                  <div className="panel-title">
                    <span>
                      {migrationResult.success ? "✓ 迁移成功" : "✗ 迁移失败"}
                    </span>
                  </div>
                  {migrationResult.error && (
                    <pre className="test-error">{migrationResult.error}</pre>
                  )}
                  {migrationResult.success && (
                    <p className="migration-pending-hint">
                      迁移结果已保存为待确认快照，请在下方快照列表中手动应用。
                    </p>
                  )}
                  {migrationResult.logs && migrationResult.logs.length > 0 && (
                    <div className="migration-logs">
                      <span className="test-io-label">日志</span>
                      <pre className="test-output">
                        {migrationResult.logs.join("\n")}
                      </pre>
                    </div>
                  )}
                  {migrationResult.success && migrationResult.before && (
                    <details className="migration-diff">
                      <summary>迁移前数据</summary>
                      <pre className="test-output">
                        {JSON.stringify(migrationResult.before, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              )}
            </div>
            <div className="ds-snapshots-panel">
              <div className="panel-title">
                <span>历史快照</span>
                <span className="subtitle">保存数据或执行迁移时自动创建</span>
              </div>
              {snapshots.length === 0 && (
                <div className="empty-hint">
                  暂无快照。保存数据或执行迁移时自动创建。
                </div>
              )}
              <div className="snapshot-list">
                {snapshots.map((s) => (
                  <div
                    key={s.id}
                    className={`snapshot-item${s.status === "pending" ? " snapshot-pending" : ""}`}
                  >
                    <div className="snapshot-item-head">
                      <span className="snapshot-date">
                        {new Date(s.createdAt).toLocaleString()}
                        {s.status === "pending" ? " · 待确认" : ""}
                        {s.status === "applied" ? " · 已应用" : ""}
                      </span>
                      {s.status === "pending" ? (
                        <>
                          <button
                            className="text-btn"
                            onClick={() => promoteSnapshot(s.id)}
                            disabled={loading}
                          >
                            ✅ 应用
                          </button>
                          <button
                            className="text-btn danger"
                            onClick={() => restoreSnapshot(s.id)}
                          >
                            恢复
                          </button>
                        </>
                      ) : (
                        <button
                          className="text-btn"
                          onClick={() => restoreSnapshot(s.id)}
                        >
                          恢复
                        </button>
                      )}
                    </div>
                    <pre className="snapshot-preview">
                      {JSON.stringify(s.data, null, 2).slice(0, 300)}
                      {JSON.stringify(s.data, null, 2).length > 300 ? "…" : ""}
                    </pre>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
      {subTab === "external" && (
        <div className="ext-ds-layout">
          <div className="ext-ds-list">
            <div className="panel-title">
              <span>外部数据源列表</span>
              <button className="text-btn" onClick={resetExtForm}>
                + 添加
              </button>
            </div>
            {extList.length === 0 && (
              <div className="empty-hint">
                暂无外部数据源。点击「+ 添加」配置一个 HTTP 接口作为外部数据源。
              </div>
            )}
            {extList.map((eds) => (
              <div
                key={eds.id}
                className={`ext-ds-item${editingExt === eds.id ? " ext-ds-item--active" : ""}`}
                onClick={() => editExt(eds)}
              >
                <div className="ext-ds-item-head">
                  <span className="ext-ds-name">{eds.name}</span>
                  <span className="ext-ds-method">{eds.method}</span>
                </div>
                <div className="ext-ds-url">{eds.url}</div>
                <div className="ext-ds-item-actions">
                  <button
                    className="text-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      editExt(eds);
                    }}
                  >
                    编辑
                  </button>
                  <button
                    className="text-btn danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteExt(eds.id);
                    }}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="ext-ds-form">
            <div className="panel-title">
              <span>{editingExt ? "编辑外部数据源" : "添加外部数据源"}</span>
              {editingExt && (
                <button className="text-btn" onClick={resetExtForm}>
                  取消
                </button>
              )}
            </div>
            <div className="ext-ds-form-body">
              <label>
                名称
                <input
                  className="ext-ds-input"
                  value={extForm.name}
                  onChange={(e) =>
                    setExtForm({ ...extForm, name: e.target.value })
                  }
                  placeholder="例如：用户 API"
                />
              </label>
              <label>
                URL
                <input
                  className="ext-ds-input"
                  value={extForm.url}
                  onChange={(e) =>
                    setExtForm({ ...extForm, url: e.target.value })
                  }
                  placeholder="https://api.example.com/users"
                />
              </label>
              <label>
                方法
                <select
                  className="ext-ds-input"
                  value={extForm.method}
                  onChange={(e) =>
                    setExtForm({ ...extForm, method: e.target.value })
                  }
                >
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                  <option value="PUT">PUT</option>
                  <option value="PATCH">PATCH</option>
                  <option value="DELETE">DELETE</option>
                </select>
              </label>
              <label>
                Headers (JSON)
                <textarea
                  className="ext-ds-textarea"
                  value={extForm.headers}
                  onChange={(e) =>
                    setExtForm({ ...extForm, headers: e.target.value })
                  }
                  placeholder='{"Authorization": "Bearer xxx"}'
                  rows={3}
                />
              </label>
              <label>
                输入 Schema (JSON Schema)
                <textarea
                  className="ext-ds-textarea"
                  value={extForm.inputSchema}
                  onChange={(e) =>
                    setExtForm({ ...extForm, inputSchema: e.target.value })
                  }
                  placeholder='{"type": "object", "properties": {}}'
                  rows={3}
                />
              </label>
              <label>
                输出 Schema (JSON Schema)
                <textarea
                  className="ext-ds-textarea"
                  value={extForm.outputSchema}
                  onChange={(e) =>
                    setExtForm({ ...extForm, outputSchema: e.target.value })
                  }
                  placeholder='{"type": "object", "properties": {}}'
                  rows={3}
                />
              </label>
              <button className="primary" onClick={saveExt}>
                {editingExt ? "保存修改" : "添加数据源"}
              </button>
            </div>
            {editingExt && (
              <div className="ext-ds-test">
                <div className="panel-title">
                  <span>测试请求</span>
                </div>
                <textarea
                  className="code-input"
                  value={extTestInput}
                  onChange={(e) => setExtTestInput(e.target.value)}
                  placeholder='{"key": "value"}'
                />
                <button className="ghost" onClick={() => testExt(editingExt)}>
                  ▶ 发送测试
                </button>
                {extTestResult && (
                  <div
                    className={`ext-ds-test-result ${extTestResult.error ? "ext-ds-test-err" : ""}`}
                  >
                    {extTestResult.error ? (
                      <pre className="test-error">{extTestResult.error}</pre>
                    ) : (
                      <>
                        <div className="ext-ds-test-meta">
                          状态码：{extTestResult.status} · 耗时：
                          {extTestResult.durationMs}ms
                        </div>
                        <pre className="test-output">
                          {JSON.stringify(extTestResult.data, null, 2)}
                        </pre>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
function RunsPanel({ app }) {
  const [selectedRun, setSelectedRun] = useState(null);
  const [logRun, setLogRun] = useState(null);
  const [logData, setLogData] = useState(null);
  const runs = app.runs || [];
  const viewLogs = async (run) => {
    setLogRun(run.id);
    setLogData(null);
    try {
      const data = await api(`/api/runs/${run.id}/logs`);
      setLogData(data);
    } catch (e) {
      setLogData({ error: e.message });
    }
  };
  const triggerLabel = (r) => {
    switch (r.trigger) {
      case "webhook":
        return "API 调用";
      case "schedule":
        return "定时任务";
      case "manual":
        return "手动运行";
      case "test":
        return "测试";
      case "generated_test":
        return "生成测试";
      case "diagnostic":
        return "诊断";
      case "inter_app_call":
        return "ctx.call";
      default:
        return r.trigger || "-";
    }
  };
  return (
    <div className="tab-content">
      <div className="panel-title">
        <span>运行记录（{runs.length} 次）</span>
        <span className="subtitle">
          包含版本号、数据源快照，用于判断版本切换是否合理
        </span>
      </div>
      {runs.length === 0 ? (
        <div className="runs-empty">
          暂无运行记录。发布程序后通过 API 调用即可看到记录。
        </div>
      ) : (
        <>
          <table className="runs-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>状态</th>
                <th>版本</th>
                <th>数据源</th>
                <th>耗时</th>
                <th>触发方式</th>
                <th>日志</th>
                <th>调用链</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr
                  key={r.id}
                  className={
                    r.status === "failed" || r.status === "timed_out"
                      ? "run-row-fail"
                      : ""
                  }
                >
                  <td>{new Date(r.createdAt).toLocaleString()}</td>
                  <td>
                    <span className={`run-status ${r.status}`}>{r.status}</span>
                  </td>
                  <td>
                    <code>v{r.versionNumber ?? "?"}</code>
                  </td>
                  <td>
                    {r.datasourceSnapshotId ? (
                      <span
                        className="ds-snapshot-ref"
                        title={r.datasourceSnapshotId}
                      >
                        {r.datasourceSnapshotId.slice(0, 8)}...
                      </span>
                    ) : (
                      <span className="ds-snapshot-ref none">-</span>
                    )}
                  </td>
                  <td>{r.durationMs != null ? `${r.durationMs}ms` : "-"}</td>
                  <td>
                    <span className={`trigger-tag trigger-${r.trigger}`}>
                      {triggerLabel(r)}
                    </span>
                  </td>
                  <td>
                    <button className="text-btn" onClick={() => viewLogs(r)}>
                      {r.logs?.length ? `${r.logs.length} 条` : "查看"}
                    </button>
                  </td>
                  <td>
                    {r.parentRunId || r.callerAppId ? (
                      <button
                        className="text-btn"
                        onClick={() => setSelectedRun(r)}
                      >
                        调用链
                      </button>
                    ) : (
                      <span className="chain-arrow">-</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {selectedRun && (
            <CallChainView
              app={app}
              run={selectedRun}
              onClose={() => setSelectedRun(null)}
            />
          )}
          {logRun && (
            <LogViewer
              runId={logRun}
              data={logData}
              onClose={() => {
                setLogRun(null);
                setLogData(null);
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
function LogViewer({ runId, data, onClose }) {
  return (
    <div className="log-viewer">
      <div className="panel-title">
        <span>运行日志：{runId.slice(0, 8)}...</span>
        <button className="text-btn" onClick={onClose}>
          关闭
        </button>
      </div>
      {!data ? (
        <div className="chain-empty">加载中…</div>
      ) : data.error ? (
        <div className="chain-empty">加载失败：{data.error}</div>
      ) : !data.logs?.length ? (
        <div className="chain-empty">
          该次运行未调用 ctx.log()，无日志输出。
        </div>
      ) : (
        <div className="log-list">
          {data.logs.map((l, i) => (
            <div key={i} className={`log-entry log-${l.level}`}>
              <span className="log-time">
                {new Date(l.at).toLocaleTimeString()}
              </span>
              <span className={`log-level log-${l.level}`}>{l.level}</span>
              <span className="log-msg">{l.message}</span>
              {l.fields && (
                <pre className="log-fields">
                  {JSON.stringify(l.fields, null, 2)}
                </pre>
              )}
            </div>
          ))}
          {data.error && (
            <div className="log-entry log-error">
              <span className="log-level log-error">error</span>
              <span className="log-msg">
                {data.error.message || data.error.code}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
function StatsView({ stats, refresh }) {
  if (!stats) {
    return (
      <div className="tab-content">
        <div className="stats-header">
          <h2>访问统计</h2>
          <button className="btn primary" onClick={refresh}>
            刷新
          </button>
        </div>
        <div className="stats-empty">加载中…</div>
      </div>
    );
  }
  const {
    totalRuns,
    byStatus,
    recentLogs,
    perApp,
    perVersion,
    totalApps,
    totalPublished,
  } = stats;
  return (
    <div className="tab-content">
      <div className="stats-header">
        <h2>访问统计</h2>
        <button className="btn primary" onClick={refresh}>
          ⟳ 刷新
        </button>
      </div>
      <div className="stats-overview">
        <div className="stat-card">
          <div className="stat-num">{totalRuns}</div>
          <div className="stat-label">总运行次数</div>
        </div>
        <div className="stat-card success">
          <div className="stat-num">{byStatus.succeeded || 0}</div>
          <div className="stat-label">成功</div>
        </div>
        <div className="stat-card fail">
          <div className="stat-num">{byStatus.failed || 0}</div>
          <div className="stat-label">失败</div>
        </div>
        <div className="stat-card warn">
          <div className="stat-num">{byStatus.timed_out || 0}</div>
          <div className="stat-label">超时</div>
        </div>
        <div className="stat-card">
          <div className="stat-num">{totalApps}</div>
          <div className="stat-label">应用数</div>
        </div>
        <div className="stat-card">
          <div className="stat-num">{totalPublished}</div>
          <div className="stat-label">已发布</div>
        </div>
      </div>
      {perVersion && perVersion.length > 0 && (
        <>
          <h3 className="stats-section-title">按版本统计（版本切换参考）</h3>
          <table className="stats-table">
            <thead>
              <tr>
                <th>应用 / 版本</th>
                <th>总次数</th>
                <th>成功</th>
                <th>失败</th>
                <th>成功率</th>
              </tr>
            </thead>
            <tbody>
              {perVersion.map((v, i) => (
                <tr
                  key={i}
                  className={
                    v.successRate < 50
                      ? "row-fail"
                      : v.successRate < 90
                        ? "row-warn"
                        : ""
                  }
                >
                  <td>{v.name}</td>
                  <td>{v.total}</td>
                  <td className="col-success">{v.succeeded}</td>
                  <td className="col-fail">{v.failed}</td>
                  <td>
                    <span
                      className={`rate-badge ${v.successRate >= 90 ? "good" : v.successRate >= 50 ? "warn" : "bad"}`}
                    >
                      {v.successRate}%
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <h3 className="stats-section-title">按应用统计</h3>
      {perApp && perApp.length > 0 ? (
        <table className="stats-table">
          <thead>
            <tr>
              <th>应用名称</th>
              <th>总次数</th>
              <th>成功</th>
              <th>失败</th>
              <th>超时</th>
              <th>拒绝</th>
            </tr>
          </thead>
          <tbody>
            {perApp.map((a, i) => (
              <tr key={i}>
                <td>{a.name}</td>
                <td>{a.total}</td>
                <td className="col-success">{a.succeeded}</td>
                <td className="col-fail">{a.failed}</td>
                <td>{a.timed_out}</td>
                <td>{a.rejected}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="stats-empty">暂无运行数据</div>
      )}
      <h3 className="stats-section-title">最近日志</h3>
      {recentLogs && recentLogs.length > 0 ? (
        <div className="recent-log-list">
          {recentLogs.map((l, i) => (
            <div key={i} className={`recent-log-entry log-${l.level}`}>
              <span className="log-time">
                {new Date(l.at).toLocaleTimeString()}
              </span>
              <span className={`log-level log-${l.level}`}>{l.level}</span>
              <span className="log-app">
                {l.appName || l.appId?.slice(0, 8)}
              </span>
              <span className="log-msg">{l.message}</span>
              {l.fields && (
                <span className="log-fields-inline">
                  {JSON.stringify(l.fields)}
                </span>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="stats-empty">暂无日志</div>
      )}
    </div>
  );
}
function CallChainView({ app, run, onClose }) {
  const [chain, setChain] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    api(`/api/runs/${run.id}/chain`)
      .then(setChain)
      .catch(() => setChain(null))
      .finally(() => setLoading(false));
  }, [run.id]);
  return (
    <div className="call-chain">
      <div className="panel-title">
        <span>调用链：Run {run.id.slice(0, 8)}...</span>
        <button className="text-btn" onClick={onClose}>
          关闭
        </button>
      </div>
      {loading ? (
        <div className="chain-empty">加载中…</div>
      ) : !chain || !chain.nodes?.length ? (
        <div className="chain-empty">无调用链数据（可能是单次直接调用）</div>
      ) : (
        <div className="chain-tree">
          {chain.nodes.map((node, i) => (
            <div
              key={i}
              className={`chain-node ${node.depth === 0 ? "chain-root" : node.depth === 1 ? "chain-child" : "chain-deep"}`}
            >
              {node.depth > 0 && <span className="chain-arrow">↳</span>}
              <span className="chain-app">
                {node.appName || node.appCode || node.appId?.slice(0, 8)}
              </span>
              <span className="chain-duration">
                {node.durationMs != null ? `${node.durationMs}ms` : ""}
              </span>
              <span className={`run-status ${node.status} chain-status`}>
                {node.status}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
function VersionPanel({ app, toast, refresh }) {
  const [versions, setVersions] = useState([]);
  useEffect(() => {
    setVersions(app.versions || []);
  }, [app.id, app.versions?.length]);

  const setDefault = async (versionId) => {
    try {
      const r = await api(`/api/apps/${app.id}/set-default-version`, {
        method: "POST",
        body: JSON.stringify({ versionId }),
      });
      toast(`已将 v${r.versionNumber} 设为默认版本（发布版本）。`, "success");
      await refresh();
    } catch (e) {
      toast(e.message, "error");
    }
  };

  return (
    <div className="tab-content">
      <div className="panel-title">
        <span>版本列表</span>
        <span className="subtitle">
          新版本保存后需手动验证，再设为默认版本（发布过程）
        </span>
      </div>
      {versions.length === 0 && (
        <div className="empty-hint">
          暂无版本。请先在代码编辑器中"编译并保存"。
        </div>
      )}
      <div className="version-list">
        {versions.map((v) => {
          const isDraft = v.id === app.draftVersionId;
          const isPublished = v.id === app.publishedVersionId;
          return (
            <div
              key={v.id}
              className={`version-item ${isPublished ? "version-published" : ""} ${isDraft ? "version-draft" : ""}`}
            >
              <div className="version-item-left">
                <span className="version-num">v{v.number}</span>
                <span className={`version-status ${v.status}`}>{v.status}</span>
                {isDraft && <span className="version-tag">当前编辑</span>}
                {isPublished && (
                  <span className="version-tag live">默认版本</span>
                )}
              </div>
              <div className="version-item-mid">
                <span className="version-source">{v.source || "manual"}</span>
                <span className="version-date">
                  {new Date(v.createdAt).toLocaleString()}
                </span>
                <span className="version-summary">{v.summary || ""}</span>
              </div>
              <div className="version-item-right">
                {v.status === "ready" && v.id !== app.publishedVersionId && (
                  <button className="text-btn" onClick={() => setDefault(v.id)}>
                    设为默认版本
                  </button>
                )}
                {v.status !== "ready" && (
                  <span className="version-hint">
                    需要诊断通过后才能设为默认版本
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
function DocsPanel({
  app,
  deployment,
  slugDraft,
  setSlugDraft,
  updateSlug,
  getUrl,
  curlCmd,
}) {
  const [invokeDocs, setInvokeDocs] = useState(null);
  const [loadingDocs, setLoadingDocs] = useState(false);
  useEffect(() => {
    setLoadingDocs(true);
    api(`/api/apps/${app.id}/invoke-docs`)
      .then(setInvokeDocs)
      .catch(() => {})
      .finally(() => setLoadingDocs(false));
  }, [app.id, app.publishedVersionId]);

  const invokeUrl = `${location.origin}/invoke/${app.code}`;
  return (
    <div className="tab-content">
      <div className="info-grid">
        <div className="info">
          <h3>调用地址</h3>
          <code>POST /invoke/{app.code || "app-code"}</code>
          <p>
            编码（URL 字符，允许重复）：
            <input
              className="slug-input"
              value={slugDraft}
              onChange={(e) => setSlugDraft(e.target.value)}
              spellCheck="false"
              placeholder="fn-app"
            />
            <button className="text-btn" onClick={updateSlug}>
              保存
            </button>
          </p>
        </div>
        <div className="info">
          <h3>最近运行</h3>
          <p>
            {app.runs?.[0]
              ? `${app.runs[0].status} · ${app.runs[0].trigger} · ${app.runs[0].durationMs}ms`
              : "暂无运行记录"}
          </p>
        </div>
      </div>
      {deployment && (
        <section className="deployment">
          <h3>发布成功</h3>
          <p>当前版本：v{invokeDocs?.publishedVersion?.number || "?"}</p>
          <hr />
          <p className="deployment__label">
            🔗 浮动调用（始终跟随最新发布版本）：
          </p>
          <p>GET（浏览器）：</p>
          <code>{getUrl}</code>
          <button className="ghost" onClick={() => copy(getUrl)}>
            复制
          </button>
          <p>POST（curl）：</p>
          <code>{curlCmd}</code>
          <button className="ghost" onClick={() => copy(curlCmd)}>
            复制
          </button>
          {invokeDocs?.examples?.pinnedCurl && (
            <>
              <hr />
              <p className="deployment__label">
                📌 钉选版本（始终调用 v{invokeDocs.publishedVersion.number}
                ，不受后续发布影响）：
              </p>
              <p>GET（浏览器）：</p>
              <code>{invokeDocs.methods?.get?.pinnedUrl}</code>
              <button
                className="ghost"
                onClick={() => copy(invokeDocs.methods?.get?.pinnedUrl || "")}
              >
                复制
              </button>
              <p>POST（curl）：</p>
              <code>{invokeDocs.examples.pinnedCurl}</code>
              <button
                className="ghost"
                onClick={() => copy(invokeDocs.examples.pinnedCurl || "")}
              >
                复制
              </button>
            </>
          )}
          <hr />
          <p>Bearer key（仅显示一次）</p>
          <code className="secret">{deployment.webhookKey}</code>
          <button className="ghost" onClick={() => copy(deployment.webhookKey)}>
            复制
          </button>
        </section>
      )}
      {loadingDocs && <div className="loading-docs">加载调用文档…</div>}
      {invokeDocs && !deployment && (
        <div className="invoke-docs-preview">
          <h3>调用文档预览</h3>
          <div className="doc-section">
            <h4>接口地址</h4>
            <code>{invokeUrl}</code>
            <p className="docs-note">
              发布后还支持版本钉选：
              <code>/invoke-version/{app.code || "app-code"}/1</code>、
              <code>/invoke-version/{app.code || "app-code"}/2</code>{" "}
              等，始终调用指定版本不受后续发布影响。
            </p>
          </div>
          <div className="doc-section">
            <h4>支持的方法</h4>
            <p>{invokeDocs.endpoint?.methods?.join(", ") || "GET, POST"}</p>
          </div>
          <div className="doc-section">
            <h4>认证方式</h4>
            <p>{invokeDocs.auth}</p>
          </div>
          {invokeDocs.sampleInput && (
            <div className="doc-section">
              <h4>示例输入</h4>
              <pre>{JSON.stringify(invokeDocs.sampleInput, null, 2)}</pre>
            </div>
          )}
          {invokeDocs.examples && (
            <div className="doc-section">
              <h4>调用示例</h4>
              <div className="doc-example">
                <p>浏览器：</p>
                <code>
                  {invokeDocs.examples.browser?.replace(/<YOUR_KEY>/g, "***")}
                </code>
              </div>
              <div className="doc-example">
                <p>curl：</p>
                <code>
                  {invokeDocs.examples.curl?.replace(/<YOUR_KEY>/g, "***")}
                </code>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── RuntimePage ───────────────────────────────────────────────────────────
// 运行态小程序页面：独立壳子，侧边栏入口 + 主界面用 generative-lego 渲染 JSON 页面
function RuntimePage() {
  const { code } = useParams();
  const [pages, setPages] = useState([]);
  const [activePageId, setActivePageId] = useState(null);
  const [pageData, setPageData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    api(`/api/apps/code/${code}/pages`)
      .then((data) => {
        setPages(data);
        if (data.length > 0) setActivePageId(data[0].id);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [code]);

  const activePage = useMemo(
    () => pages.find((p) => p.id === activePageId),
    [pages, activePageId],
  );

  useEffect(() => {
    if (!activePageId) return;
    setPageData(null);
    api(
      `/api/apps/${activePage?.appId || pages[0]?.appId}/pages/${activePageId}/data`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    )
      .then(({ data }) => setPageData(data))
      .catch(() => setPageData({}));
  }, [activePageId]);

  if (loading) return <div className="runtime-loading">加载中…</div>;
  if (error) return <div className="runtime-error">加载失败：{error}</div>;
  if (!pages.length)
    return (
      <div className="runtime-empty">
        <p>该应用尚未配置页面。</p>
        <a href="/">返回管理后台</a>
      </div>
    );

  return (
    <div className="runtime-shell">
      <aside className="runtime-sidebar">
        <div className="runtime-brand">
          <span className="mark">H</span>
          <span>hosta</span>
        </div>
        <nav className="runtime-nav">
          {pages.map((p) => (
            <button
              key={p.id}
              className={`runtime-nav-item${p.id === activePageId ? " active" : ""}`}
              onClick={() => setActivePageId(p.id)}
            >
              <span className="dot"></span>
              {p.name}
            </button>
          ))}
        </nav>
        <div className="runtime-sidebar-bottom">
          <a href="/">← 管理后台</a>
        </div>
      </aside>
      <main className="runtime-main">
        <header className="runtime-header">
          <h1>{activePage?.name || "页面"}</h1>
        </header>
        <div className="runtime-content">
          {activePage?.pageConfig?.regions?.length > 0 ? (
            <GuiFramework
              config={activePage.pageConfig}
              componentRegistry={legoComponentRegistry}
              loading={<div className="runtime-loading">组件加载中…</div>}
            />
          ) : (
            <div className="runtime-empty">
              <p>该页面尚未配置组件。</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

// ── PagesPanel ─────────────────────────────────────────────────────────────
// 管理后台「页面配置」tab
function PagesPanel({ app, toast, refresh }) {
  const [pages, setPages] = useState([]);
  const [loadingPages, setLoadingPages] = useState(true);
  const [editing, setEditing] = useState(null);
  const [isNew, setIsNew] = useState(false);
  const [aiPageOpen, setAiPageOpen] = useState(false);

  useEffect(() => {
    setLoadingPages(true);
    api(`/api/apps/${app.id}/pages`)
      .then((data) => setPages(data))
      .catch(() => setPages([]))
      .finally(() => setLoadingPages(false));
  }, [app.id]);

  const startNew = () => {
    setIsNew(true);
    setEditing({
      id: null,
      name: "",
      pageConfig: JSON.stringify(
        {
          version: "1",
          layout: { type: "grid", config: { columns: 1 } },
          regions: [],
        },
        null,
        2,
      ),
      processScript: "",
    });
  };

  const startEdit = (page) => {
    setIsNew(false);
    setEditing({
      id: page.id,
      name: page.name,
      pageConfig: JSON.stringify(page.pageConfig || {}, null, 2),
      processScript: page.processScript || "",
    });
  };

  const cancel = () => {
    setEditing(null);
    setIsNew(false);
  };

  const save = async () => {
    try {
      let pageConfig;
      try {
        pageConfig = JSON.parse(editing.pageConfig);
      } catch {
        toast("pageConfig 不是合法 JSON", "error");
        return;
      }
      if (isNew) {
        const created = await api(`/api/apps/${app.id}/pages`, {
          method: "POST",
          body: JSON.stringify({
            name: editing.name,
            pageConfig,
            processScript: editing.processScript,
          }),
        });
        setPages((prev) => [...prev, created]);
        toast("页面已创建", "success");
      } else {
        const updated = await api(`/api/apps/${app.id}/pages/${editing.id}`, {
          method: "PUT",
          body: JSON.stringify({
            name: editing.name,
            pageConfig,
            processScript: editing.processScript,
          }),
        });
        setPages((prev) =>
          prev.map((p) => (p.id === editing.id ? { ...p, ...updated } : p)),
        );
        toast("页面已更新", "success");
      }
      setEditing(null);
      setIsNew(false);
      await refresh();
    } catch (e) {
      toast(e.message, "error");
    }
  };

  const remove = async (pageId) => {
    if (!confirm("确认删除此页面？")) return;
    try {
      await api(`/api/apps/${app.id}/pages/${pageId}`, { method: "DELETE" });
      setPages((prev) => prev.filter((p) => p.id !== pageId));
      toast("页面已删除", "success");
      await refresh();
    } catch (e) {
      toast(e.message, "error");
    }
  };

  return (
    <div className="tab-content">
      <div className="editor-head">
        <div>
          <span className="status-ready">
            {loadingPages ? "加载中…" : `${pages.length} 个页面`}
          </span>
          <span>运行地址：/app/{app.code}</span>
        </div>
        <div>
          <button onClick={startNew}>+ 新建页面</button>
        </div>
      </div>

      {editing ? (
        <div className="pages-editor">
          <div className="pages-editor-head">
            <h3>{isNew ? "创建页面" : `编辑：${editing.name}`}</h3>
            <div>
              <button className="ghost" onClick={() => setAiPageOpen(true)}>
                🤖 AI 生成配置
              </button>
              <button className="ghost" onClick={cancel}>
                取消
              </button>
              <button onClick={save}>保存</button>
            </div>
          </div>
          <div className="form-group">
            <label>页面名称</label>
            <input
              className="field"
              value={editing.name}
              onChange={(e) =>
                setEditing((prev) => ({ ...prev, name: e.target.value }))
              }
              placeholder="例如：首页、数据看板"
            />
          </div>
          <div className="form-group">
            <label>页面配置（PageConfig JSON）</label>
            <textarea
              className="code-input"
              rows={20}
              value={editing.pageConfig}
              onChange={(e) =>
                setEditing((prev) => ({
                  ...prev,
                  pageConfig: e.target.value,
                }))
              }
              placeholder="输入 PageConfig JSON…"
            />
          </div>
          <div className="form-group">
            <label>数据处理脚本（可选，用于在渲染前处理数据）</label>
            <textarea
              className="code-input"
              rows={8}
              value={editing.processScript}
              onChange={(e) =>
                setEditing((prev) => ({
                  ...prev,
                  processScript: e.target.value,
                }))
              }
              placeholder={`async function(input, datasource) {\n  // 处理数据并返回\n  return { ...datasource, ...input };\n}`}
            />
          </div>
        </div>
      ) : (
        <div className="pages-list">
          {pages.length === 0 ? (
            <div className="empty-state">
              <p>暂无页面配置。</p>
              <p>创建页面后，可通过 /app/{app.code} 访问运行态页面。</p>
            </div>
          ) : (
            <>
              <div className="pages-list-header">
                <span className="pages-list-header__name">页面名称</span>
                <span className="pages-list-header__regions">区域数</span>
                <span className="pages-list-header__time">更新时间</span>
                <span className="pages-list-header__actions">操作</span>
              </div>
              <div className="pages-list-body">
                {pages.map((p) => (
                  <div key={p.id} className="page-card">
                    <div className="page-card__name">
                      <span className="page-card__icon">📄</span>
                      <strong>{p.name}</strong>
                    </div>
                    <div className="page-card__regions">
                      <span className="page-card__badge">
                        {p.pageConfig?.regions?.length || 0} 个区域
                      </span>
                    </div>
                    <div className="page-card__time">
                      {p.updatedAt
                        ? new Date(p.updatedAt).toLocaleString()
                        : p.createdAt
                          ? new Date(p.createdAt).toLocaleString()
                          : "-"}
                    </div>
                    <div className="page-card__actions">
                      <button className="ghost" onClick={() => startEdit(p)}>
                        编辑
                      </button>
                      <button
                        className="ghost"
                        onClick={() =>
                          window.open(`/app/${app.code}`, "_blank")
                        }
                      >
                        预览
                      </button>
                      <button className="danger" onClick={() => remove(p.id)}>
                        删除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── AI 生成页面配置 Drawer ── */}
      <AIDrawer
        open={aiPageOpen}
        onClose={() => setAiPageOpen(false)}
        title="生成页面配置"
        goal={`为「${editing?.name || ""}」生成 PageConfig JSON 配置。`}
        context={`程序：${app.name}\n${app.description ? `描述：${app.description}` : ""}`}
        placeholder="描述你想要的页面：仪表盘/数据表格/详情页/表单... 可附加具体需求如「显示订单列表，带搜索和分页」"
        onGenerate={async (instruction) => {
          const { pageConfig } = await api(`/api/ai/generate-page`, {
            method: "POST",
            body: JSON.stringify({
              name: editing?.name || "",
              description: instruction,
              appName: app.name,
              appDescription: app.description,
              appId: app.id,
            }),
          });
          return {
            summary: `已生成 ${pageConfig?.regions?.length || 0} 个区域`,
            result: JSON.stringify(pageConfig, null, 2),
          };
        }}
        onApply={(_, result) => {
          setEditing((prev) => (prev ? { ...prev, pageConfig: result } : prev));
          toast("页面配置已应用。", "success");
        }}
      />
    </div>
  );
}

createRoot(document.getElementById("root")).render(<RouterApp />);
