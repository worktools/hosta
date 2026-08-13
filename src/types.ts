// ── 核心类型定义 ──────────────────────────────────────────────────────────────

export interface App {
  id: string;
  serial: number;
  code: string;
  name: string;
  description: string;
  requirements: string;
  runtime: "javascript" | "wasm";
  language: "javascript" | "rust" | "moonbit";
  sampleInput: Record<string, unknown>;
  draftVersionId: string | null;
  publishedVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Version {
  id: string;
  appId: string;
  runtime: "javascript" | "wasm";
  language: "javascript" | "rust" | "moonbit";
  sourceCode?: string;
  wasmSize?: number;
  number: number;
  status: "ready" | "needs_revision";
  source: string;
  summary: string;
  code: string;
  codeSha256: string;
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
  tests: TestCase[];
  validationError: string | null;
  diagnostics?: Diagnostic[];
  revisedFrom?: string | null;
  createdAt: string;
}

export interface TestCase {
  name: string;
  input: Record<string, unknown>;
  expectedOutput?: Record<string, unknown>;
}

export interface Deployment {
  id: string;
  appId: string;
  versionId: string;
  status: "active" | "inactive";
  keyHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface Run {
  id: string;
  appId: string;
  versionId: string;
  versionNumber: number;
  datasourceSnapshotId: string | null;
  trigger: string;
  status: "running" | "succeeded" | "failed" | "timed_out" | "rejected";
  input: Record<string, unknown>;
  result?: unknown;
  error?: { code: string; message: string; schemaErrors?: string[] } | null;
  logs: LogEntry[];
  durationMs?: number;
  parentRunId: string | null;
  callerAppId: string | null;
  callDepth: number;
  createdAt: string;
  startedAt: string;
  finishedAt?: string;
}

export interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fields: Record<string, unknown> | null;
  at: string;
}

export interface Schedule {
  id: string;
  appId: string;
  versionId: string;
  input: Record<string, unknown>;
  scheduleType: "interval" | "daily" | "cron";
  intervalSeconds: number;
  dailyAt: string | null;
  cronExpression: string | null;
  status: "active" | "disabled";
  createdAt: string;
  nextRunAt: string;
  lastRunAt: string | null;
  lastRunId: string | null;
}

export interface Datasource {
  id: string;
  appId: string;
  data: Record<string, unknown>;
  schema: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface DatasourceSnapshot {
  id: string;
  appId: string;
  data: Record<string, unknown>;
  createdAt: string;
  status?: "pending" | "applied";
  type?: "migration" | null;
  before?: Record<string, unknown>;
  appliedAt?: string;
}

export interface ExternalDatasource {
  id: string;
  appId: string;
  name: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface Page {
  id: string;
  appId: string;
  name: string;
  pageConfig: PageConfig;
  processScript: string;
  createdAt: string;
  updatedAt: string;
}

export interface PageConfig {
  version: "1.0";
  layout: {
    type: "grid" | "flex" | "tabs" | "free";
    config: Record<string, unknown>;
  };
  regions: Region[];
  dataSources?: DataSourceBinding[];
}

export interface Region {
  id: string;
  position: { row: number; col: number; rowSpan?: number; colSpan?: number };
  component: ComponentConfig;
}

export interface ComponentConfig {
  type: string;
  id?: string;
  props: Record<string, unknown>;
  children?: ComponentConfig[];
}

export interface DataSourceBinding {
  id: string;
  binding: Array<{ regionId: string; field: string }>;
}

export interface ModelCall {
  id: string;
  appId: string;
  versionId: string;
  provider: string;
  model: string | null;
  usage: Record<string, unknown> | null;
  estimatedCost: number | null;
  createdAt: string;
}

export interface Diagnostic {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  runId?: string;
}

export interface Store {
  apps: App[];
  versions: Version[];
  deployments: Deployment[];
  runs: Run[];
  schedules: Schedule[];
  modelCalls: ModelCall[];
  datasources: Datasource[];
  datasourceSnapshots: DatasourceSnapshot[];
  externalDatasources: ExternalDatasource[];
  pages: Page[];
}

export interface PublicApp extends App {
  draftVersion: Version | null;
  publishedVersion: Version | null;
  versions: Version[];
  datasource: {
    data: Record<string, unknown>;
    schema: Record<string, unknown> | null;
    updatedAt: string | null;
  };
  externalDatasources: Array<{
    id: string;
    name: string;
    url: string;
    method: string;
    headers: Record<string, string>;
    inputSchema: Record<string, unknown> | null;
    outputSchema: Record<string, unknown> | null;
    createdAt: string;
    updatedAt: string;
  }>;
  deployments: Deployment[];
  schedules: Schedule[];
  modelCalls: ModelCall[];
  runs: Run[];
  pages: Page[];
}

export interface LLMResult {
  source: string;
  summary: string;
  code: string | null;
  tests: TestCase[];
  usage: Record<string, unknown> | null;
  model: string | null;
}

export interface LLMSampleResult {
  source: string;
  model: string | null;
  input: Record<string, unknown>;
}

export interface LLMRefineResult {
  source: string;
  summary: string;
  code: string;
  tests: TestCase[];
  usage: Record<string, unknown> | null;
  model: string | null;
}

export interface LLMRefineRequirementsResult {
  source: string;
  summary: string;
  refined: string;
  usage: Record<string, unknown> | null;
  model: string | null;
}

export interface LLMGeneratePageResult {
  pageConfig: PageConfig;
}

export interface LLMGenerateSchemaResult {
  schema: Record<string, unknown>;
}

export interface WasmEnvelope {
  ok: boolean;
  data?: string;
  error?: { code: string; message: string };
}

export interface ExecuteOptions {
  parentRunId?: string;
  callerAppId?: string;
  callDepth?: number;
}

export interface QualityScore {
  score: number;
  maxScore: number;
  details: string[];
}

export interface InvokeDocs {
  path: string;
  full: string;
  get: Record<string, unknown> | null;
  post: Record<string, unknown> | null;
  examples: Record<string, unknown> | null;
  sampleInput: Record<string, unknown>;
}

export interface CompileResult {
  binary: string;
  size: number;
}

export interface FormatResult {
  formatted: string;
  formatter: string | null;
}

export interface MigrationResult {
  success: boolean;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  logs?: string[];
  error?: string;
}
