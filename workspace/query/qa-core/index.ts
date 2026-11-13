/**
 * 问答总调度 + **后端进程入口**（目标 2.1 起 D2-10；2.2 起承载**请求 / 流式 / 取消**三条链路）。
 *
 * 双重身份：
 *   ① 主进程里 `bootstrapQaCore(paths)` —— 接收**注入**的 AppPaths（本模块不解析路径）；
 *   ② utilityProcess 里被 `utilityProcess.fork()` 直接加载 —— 模块顶层检测到 `process.parentPort`
 *      就自动接管消息循环（见 `startBackendWorker`）。
 *
 * 🔴 本模块**不得** import `launcher/bootstrap` 的运行时成员（只能 `import type`）：
 *   bootstrap 顶层 `import { app } from 'electron'`，而 utilityProcess 里 `require('electron')` 只拿到
 *   `{ net, systemPreferences }`（**没有 `app`**）—— 调 `app.getAppPath()` 会在运行时 TypeError。
 *   实测原文：交接文档/验收记录/目标2/02-utilityprocess.md。
 *
 * 目标 2.2 的取舍：
 *   · **历史**暂存内存（`state.history`）—— 2.5 落 `data/runtime/sessions.sqlite` 后换成读库，接口不变；
 *   · **提示词与历史裁剪**由本进程负责（`evidence-prompt/`），渲染进程不再碰 payload（D2-13）；
 *   · 流式 token **批量发**：12 字符或 100 ms，先到者（D2-20）。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { guardStdio, logEvent, stdioErrorCount } from '../launcher/diagnostics/index'
// 目标 5 · 5.1：每轮问答档案（决策 D26；**旁路**，失败只记 app.log）
import { loadLoggingConfig, writeTurnArchive, type Judgment, type TimelineStep } from './archive'
import {
  assignCitations,
  buildGroundedMessages,
  buildMessages,
  buildSystemPrompt,
  loadEvidenceConfig,
  loadPrompts,
  type ChatMessage,
  type EvidenceConfig,
  type PromptsConfig,
} from '../evidence-prompt/index'
import { retrieveText, retrieveTextWithRerank } from '../text-retrieval/index'
import { EN_PROMPTS, buildGroundedMessagesEn, buildPlainMessagesEn } from '../evidence-prompt/en'
import { localizeBundle, mapBundleEn, mapGraphOverviewEn } from '../shared/locale'
import { retrieveTextEn } from '../text-retrieval/en'
import type { TextConfig } from '../text-retrieval/index'
import { retrieveGraph } from '../graph-retrieval/index'
import type { DiagnosticsConfig, GraphConfig } from '../graph-retrieval/index'
// U1 用户知识库（负责人追加）：存储层在 user-kb.ts，本文件只做"薄接线"
import {
  KbError,
  deleteUserEntity,
  deleteUserText,
  deleteUserTriple,
  listUserKb,
  loadUserVectors,
  reindexUserKb,
  saveUserEntity,
  saveUserText,
  saveUserTriple,
  USER_VECTOR_MODEL,
  type Embedder,
  type UserEntityInput,
  type UserTextInput,
  type UserTripleInput,
} from './user-kb'
import { embed, rerank } from '../answer-generation/index'
import type { AppPaths } from '../launcher/bootstrap/index'
import type { AnswerConfig, ServiceStatus } from '../launcher/process-manager/index'
// 🆕 v0.3.2：双档分档（档位快照 + 按档合并配置）
import { dialConfig, type Dial, type DialSnapshot } from '../shared/dial'
import type { BundleVersion, EvidenceBundle, EvidenceLevel, GraphOverview, GraphOverviewEntity, GraphOverviewTriple, PathName, PathStatus, TextEvidence } from '../shared/types'
import type { UserKbSnapshot } from '../shared/types'

/** 证据包契约版本（类型级常量在 shared/types.ts —— 那里只放契约，不产运行时文件） */
/** 🔴 U4 升版：文本证据新增 `kind:'user'`（用户自建文本）→ 1.0 → 1.1 */
/** 🔴 v1.2 升版：删除来源定位字段（docTitle/chapter/section/page/表图号），定位只用块编号 → 1.1 → 1.2 */
const BUNDLE_VERSION: BundleVersion = '1.3'

/** 流式批量参数（D2-20：**12 字符 / 100 ms，先到者**） */
const BATCH_CHARS = 12
const BATCH_MS = 100

// ---------------------------------------------------------------------------
// 协议（施工单 §4.1）
// ---------------------------------------------------------------------------

export interface ChatReq {
  id: number
  kind: 'chat'
  sessionId: string
  assistantMessageId: string
  /** 只发本轮提问；历史由后端自己取（2.2 内存 / 2.5 起读会话库） */
  userMessage: { id: string; content: string; createdAt: number }
}

interface AbortReq {
  id: number
  kind: 'abort'
  targetId: number
}

/** 一条会话消息（与渲染进程 `types.Message` 同形；2.5 起落 sessions.sqlite） */
export interface StoredMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  status?: string
  firstTokenAt?: number
  finishedAt?: number
  error?: string
  /** 目标 5 · D28：本轮证据包（来自 `message_evidence` 表；老会话没有 → undefined） */
  evidence?: unknown
}

export interface StoredSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: StoredMessage[]
}

/** 会话 CRUD（施工单 §4.1 的 Req；回复统一走 { kind:'reply', id, data }） */
type SessionReq =
  | { id: number; kind: 'session.list' }
  | { id: number; kind: 'session.save'; session: StoredSession }
  | { id: number; kind: 'session.delete'; sessionId: string }
  | { id: number; kind: 'session.clear' }

/** 主进程 → 后端：模型服务状态与参数（不是渲染进程协议的一部分） */
interface ServiceCtl {
  kind: 'service'
  status: ServiceStatus
  /** 目标 2.5：三个服务的状态（各自端口）—— embedding / reranker 的端口后端要用 */
  services?: ServiceStatus[]
  answer?: AnswerConfig
  /** 🆕 v0.3.2：档位快照（由 process-manager 下发；后端据此按档取配置 + 记档案） */
  dial?: DialSnapshot
}

/** 可收发的端口（`process.parentPort` 或主进程转交过来的 `MessagePortMain`） */
interface PortLike {
  postMessage: (message: unknown) => void
  on: (event: 'message', listener: (e: { data: unknown }) => void) => unknown
  start?: () => void
}

interface BackendState {
  paths: AppPaths | null
  service: ServiceStatus | null
  /** 目标 2.5：三个服务的最近状态（查找 embedding / reranker 端口用） */
  services: ServiceStatus[]
  answer: AnswerConfig | null
  /** 🆕 v0.3.2：档位快照（主进程下发；null = 还没收到 → 按顶层配置走，即 GPU 档口径） */
  dial: DialSnapshot | null
  /** 会话 → 历史（**2.2 临时放内存**，2.5 换成 sessions.sqlite） */
  history: Map<string, ChatMessage[]>
  /** 在飞的请求 → 取消句柄（AbortController 不能跨进程传，所以取消走独立消息） */
  inflight: Map<number, AbortController>
}

const state: BackendState = {
  paths: null,
  service: null,
  services: [],
  answer: null,
  dial: null,
  history: new Map(),
  inflight: new Map(),
}

// ---------------------------------------------------------------------------
// 会话库（目标 2.5 / T2-3）：**只有 data/runtime/ 可写**（红线 R4）
// ---------------------------------------------------------------------------

/** schema（施工单 §4.3；`active_entities` 按 D2-15 推到目标 4，本目标不建） */
const SCHEMA = [
  'PRAGMA journal_mode = WAL;',
  'PRAGMA foreign_keys = ON;',
  'CREATE TABLE IF NOT EXISTS sessions (',
  '  id         TEXT PRIMARY KEY,',
  '  title      TEXT    NOT NULL,',
  '  created_at INTEGER NOT NULL,',
  '  updated_at INTEGER NOT NULL',
  ');',
  'CREATE TABLE IF NOT EXISTS messages (',
  '  id             TEXT PRIMARY KEY,',
  '  session_id     TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,',
  '  seq            INTEGER NOT NULL,',
  "  role           TEXT    NOT NULL CHECK (role IN ('user','assistant')),",
  '  content        TEXT    NOT NULL,',
  '  status         TEXT,',
  '  created_at     INTEGER NOT NULL,',
  '  first_token_at INTEGER,',
  '  finished_at    INTEGER,',
  '  error          TEXT',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);',
].join('\n')

/**
 * 目标 5 · 决策 **D28**：会话库 **加表不加列** + **首次真正启用 `user_version` 迁移**。
 * `CREATE TABLE IF NOT EXISTS` 幂等 → 老库打开时自动获得新表，**零迁移代码风险**；
 * 老会话保持「有消息、无证据」，界面如实显示（不伪造）。
 */
const MIGRATION_PATCH = [
  'CREATE TABLE IF NOT EXISTS message_evidence (',
  '  message_id     TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,',
  '  session_id     TEXT    NOT NULL,',
  '  bundle_version TEXT    NOT NULL,',
  '  evidence_json  TEXT    NOT NULL,',
  '  created_at     INTEGER NOT NULL',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_message_evidence_session ON message_evidence(session_id);',
  'PRAGMA user_version = 2;',
].join('\n')

let db: DatabaseSync | null = null

/** 打开（必要时建库）；**崩溃残留的 streaming 在这里被修掉**（施工单 §4.3 实现要点） */
function openDb(paths: AppPaths): DatabaseSync {
  if (db) return db
  mkdirSync(paths.runtimeDir, { recursive: true })
  const file = join(paths.runtimeDir, 'sessions.sqlite')
  const d = new DatabaseSync(file)
  d.exec(SCHEMA)
  // 迁移（D28）：从未升过版本的老库在这里补表；新库直接落到新结构
  const uv = d.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  const from = Number(uv && uv.user_version ? uv.user_version : 0)
  if (from < 2) {
    d.exec(MIGRATION_PATCH)
    logEvent(paths, { event: 'db:migrate', from, to: 2, added: 'message_evidence' })
  }
  const fixed = d
    .prepare("UPDATE messages SET status='error', error='上次生成被中断', finished_at=COALESCE(finished_at, ?) WHERE status='streaming'")
    .run(Date.now())
  db = d
  logEvent(paths, { event: 'db:open', file, staleStreamingFixed: Number(fixed.changes) })
  return d
}

/** 会话不存在就补一行（chat 先落库时用；标题随后由 session.save 覆盖） */
function ensureSession(d: DatabaseSync, id: string, now: number): void {
  d.prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING')
    .run(id, '新会话', now, now)
}

function nextSeq(d: DatabaseSync, sessionId: string): number {
  const row = d.prepare('SELECT COALESCE(MAX(seq), -1) AS m FROM messages WHERE session_id = ?').get(sessionId) as { m: number }
  return Number(row.m) + 1
}

/** 写一条消息（**幂等 upsert**：渲染进程稍后用同一个 id 覆盖为最终内容） */
function upsertMessage(d: DatabaseSync, sessionId: string, msg: StoredMessage, seq: number): void {
  d.prepare(
    'INSERT INTO messages (id, session_id, seq, role, content, status, created_at, first_token_at, finished_at, error) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET content=excluded.content, status=excluded.status, seq=excluded.seq, ' +
      'first_token_at=COALESCE(excluded.first_token_at, messages.first_token_at), ' +
      'finished_at=COALESCE(excluded.finished_at, messages.finished_at), error=excluded.error',
  ).run(msg.id, sessionId, seq, msg.role, msg.content, msg.status ?? null, msg.createdAt, msg.firstTokenAt ?? null, msg.finishedAt ?? null, msg.error ?? null)
}

/** 目标 5 · D28：把本轮证据包落库（幂等 upsert；级联随 messages 删除） */
function saveMessageEvidence(d: DatabaseSync, sessionId: string, messageId: string, bundleVersion: string, bundle: unknown): void {
  d.prepare(
    'INSERT INTO message_evidence (message_id, session_id, bundle_version, evidence_json, created_at) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(message_id) DO UPDATE SET bundle_version=excluded.bundle_version, evidence_json=excluded.evidence_json, created_at=excluded.created_at',
  ).run(messageId, sessionId, bundleVersion, JSON.stringify(bundle), Date.now())
}

/** 生成结束时定稿助手消息（内容/状态/首字/结束时间/错误） */
function finalizeAssistant(d: DatabaseSync, id: string, patch: { content: string; status: string; firstTokenAt: number | null; finishedAt: number; error: string | null }): void {
  d.prepare('UPDATE messages SET content=?, status=?, first_token_at=?, finished_at=?, error=? WHERE id=?')
    .run(patch.content, patch.status, patch.firstTokenAt, patch.finishedAt, patch.error, id)
}

function listSessions(d: DatabaseSync, locale: 'zh' | 'en' = 'zh', chunkDb = '', graphDb = ''): StoredSession[] {
  const sessions = d.prepare('SELECT id, title, created_at, updated_at FROM sessions ORDER BY updated_at DESC').all() as Array<{ id: string; title: string; created_at: number; updated_at: number }>
  const msgStmt = d.prepare('SELECT id, role, content, status, created_at, first_token_at, finished_at, error FROM messages WHERE session_id = ? ORDER BY seq ASC')
  // 目标 5 · D28：把证据包一并读回（**老会话没有行 → undefined**，界面如实显示「本轮未留存证据」）
  const evStmt = d.prepare('SELECT message_id, evidence_json FROM message_evidence WHERE session_id = ?')
  const parseEv = (raw: string): unknown => { try { return JSON.parse(raw) } catch { return null } }
  return sessions.map((s) => {
    const rows = msgStmt.all(s.id) as Array<{ id: string; role: 'user' | 'assistant'; content: string; status: string | null; created_at: number; first_token_at: number | null; finished_at: number | null; error: string | null }>
    const evMap = new Map((evStmt.all(s.id) as Array<{ message_id: string; evidence_json: string }>).map((r) => [r.message_id, r.evidence_json]))
    return {
      id: s.id,
      title: s.title,
      createdAt: Number(s.created_at),
      updatedAt: Number(s.updated_at),
      messages: rows.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: Number(m.created_at),
        status: m.status ?? undefined,
        firstTokenAt: m.first_token_at ?? undefined,
        finishedAt: m.finished_at ?? undefined,
        error: m.error ?? undefined,
        evidence: evMap.has(m.id)
          ? localizeBundle(parseEv(evMap.get(m.id) as string), locale, { chunkDb, graphDb })
          : undefined,
      })),
    }
  })
}

/** 整会话落库：会话行 upsert + 消息**全量对齐**（不在 payload 里的消息会被删掉 —— 覆盖"重新生成/删消息"） */
function saveSession(d: DatabaseSync, s: StoredSession): void {
  d.prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at')
    .run(s.id, s.title, s.createdAt, s.updatedAt)
  const keep: string[] = []
  s.messages.forEach((m, i) => { upsertMessage(d, s.id, m, i); keep.push(m.id) })
  if (keep.length > 0) {
    const placeholders = keep.map(() => '?').join(',')
    d.prepare('DELETE FROM messages WHERE session_id = ? AND id NOT IN (' + placeholders + ')').run(s.id, ...keep)
  } else {
    d.prepare('DELETE FROM messages WHERE session_id = ?').run(s.id)
  }
}

// ---------------------------------------------------------------------------
// 主进程侧 API
// ---------------------------------------------------------------------------

export interface QaCoreRuntime {
  paths: AppPaths
  /** 启动日志那一行（由 main.js 打印，保证只打一次） */
  describe: string
}

/** 主进程侧：后端就绪。**AppPaths 由调用方注入**，本模块不解析路径（D2-10） */
export function bootstrapQaCore(paths: AppPaths): QaCoreRuntime {
  return { paths, describe: 'qa-core 就绪：AppPaths 由主进程注入（本模块不解析路径）' }
}

/** 目标 4 接入：一次提问的入口（现在由 worker 消息循环驱动，见 handleMessage） */
export function isReady(): boolean {
  return true
}

// ---------------------------------------------------------------------------
// worker 侧：消息循环
// ---------------------------------------------------------------------------

/** worker 起来后回报给主进程的第一条消息（2.1 的验收证据都在这里） */
export interface BackendHello {
  kind: 'hello'
  pid: number
  injected: boolean
  mode: string
  appRoot: string
  binRoot: string
  runtimeDir: string
  electronProbe: string
  moduleProbe: string
  argv: string[]
}

/**
 * D2-10 的取证：worker 里 require('electron') 的真实结果（成功/失败都**原样回报**）。
 * 首次实测的意外结果：**它成功了**，但只拿到 `{ net, systemPreferences }` —— 没有 `app`。
 */
function probeElectron(): string {
  try {
    const req = createRequire(__filename)
    const m = req('electron') as Record<string, unknown>
    const keys = Object.keys(m)
    let appProbe = '(没有 app 成员)'
    if ('app' in m) {
      try {
        const eapp = m.app as { getAppPath?: () => string }
        appProbe = typeof eapp.getAppPath === 'function'
          ? 'app.getAppPath()=' + eapp.getAppPath()
          : 'app 存在但没有 getAppPath()'
      } catch (err) {
        appProbe = 'app.getAppPath() 抛错：' + (err as Error).message
      }
    }
    return 'require("electron") **成功**：typeof=object keys=' + keys.length + ' [' + keys.slice(0, 12).join(',') + '] ' + appProbe
  } catch (err) {
    return 'require("electron") **失败**：' + (err as Error).message
  }
}

/** 跨模块加载取证：按**产物侧的相对路径**require 我们的 external 后端模块 */
function probeBackendModule(): string {
  try {
    const req = createRequire(__filename)
    const mod = req('../launcher/diagnostics/index.js') as { logEvent?: unknown }
    return 'require("../launcher/diagnostics/index.js") 成功：logEvent=' + typeof mod.logEvent
  } catch (err) {
    return 'require("../launcher/diagnostics/index.js") 失败：' + (err as Error).message
  }
}

// ---------------------------------------------------------------------------
// 目标 4 · 4.5：两路检索编排（A12；2026-10-19 起 三路 → 两路）
//   顺序 = **文本路 ∥ 图路（图路内含诊断路径）**
//   每一路**独立失败、独立记录**；**失败必须写进证据包**（红线：不静默降级）
//   配置：config/retrieval/default.json（A11 单文件分组）+ config/evidence/default.json
// ---------------------------------------------------------------------------

interface RetrievalConfig {
  /** 🔴 overallTimeoutMs 是**死键**（代码从不读；见 config/retrieval 的 _overallTimeoutMs_dead_note）：
   *  保留只为了对齐配置形状，**不要**当检索总超时用 */
  common: { pathTimeoutMs: number; overallTimeoutMs: number; questionVectorDim: number; rerankBudgetMs: number }
  /** 🆕 U4：用户自建文本并入文本证据的口径（逻辑合并，不写教材库） */
  userKb?: { textK: number; textMinScore: number }
  text: TextConfig
  graph: GraphConfig
  diagnostics: DiagnosticsConfig
  /** 🔴 topN 是**死键**：运行期按各路池大小传 top_n（见 config/retrieval 的 reranker._note），配置值不读 */
  reranker: { enabled: boolean; topN: number }
  /** 🆕 v0.3.2：CPU 档覆盖块（**顶层值 = GPU 档的值**；不建 cuda 块） */
  cpu?: Record<string, unknown>
}

function loadRetrievalConfig(paths: AppPaths): RetrievalConfig {
  const file = join(paths.configDir, 'retrieval', 'default.json')
  if (!existsSync(file)) throw new Error('缺少检索配置：' + file)
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as RetrievalConfig
  } catch (err) {
    throw new Error('检索配置无法解析：' + file + '\n' + (err as Error).message)
  }
}

/** 两库只读路径（**路径拼接只在这里**，且用的是注入的 AppPaths.dataDir） */
const storeDb = (paths: AppPaths, name: 'chunk' | 'graph'): string =>
  join(paths.dataDir, 'vector-index', name, name + '.sqlite')

/**
 * 目标 5 · ① 全貌页数据（**D27**）：读 graph 库，**一次性拉全量**。
 * 渲染进程不碰文件（红线 R4）→ 只能由这里读、经 MessagePort 送过去。
 * 库是只读的、建完就不变 → **进程内缓存一次**，打开页面不用重复读。
 */
let overviewCache: GraphOverview | null = null
function graphOverview(paths: AppPaths): GraphOverview {
  if (overviewCache) return overviewCache
  const t0 = Date.now()
  const d = new DatabaseSync(storeDb(paths, 'graph'), { readOnly: true })
  try {
    const rows = d.prepare('SELECT id, name, type FROM entities').all() as Array<{ id: string; name: string; type: string }>
    const triples = d.prepare('SELECT subject_id, object_id, predicate_id FROM triples').all() as Array<{ subject_id: string; object_id: string; predicate_id: string }>
    const rels = d.prepare('SELECT id, name FROM relation_types').all() as Array<{ id: string; name: string }>
    const relName = new Map(rels.map((r) => [r.id, r.name]))
    const degree = new Map<string, number>()
    triples.forEach((t) => {
      degree.set(t.subject_id, (degree.get(t.subject_id) ?? 0) + 1)
      degree.set(t.object_id, (degree.get(t.object_id) ?? 0) + 1)
    })
    const ents: GraphOverviewEntity[] = rows.map((r) => ({ entityId: r.id, name: r.name, type: r.type, degree: 0, origin: 'curated' }))
    const trips: GraphOverviewTriple[] = triples.map((t) => ({
      subject: t.subject_id,
      object: t.object_id,
      relation: relName.get(t.predicate_id) ?? t.predicate_id,
      origin: 'curated',
    }))
    // U2：把**用户自建**的实体与边合并进来（教材部分不受影响；来源分开标）
    const kb = listUserKb(paths, storeDb(paths, 'graph'))
    for (const e of kb.entities) ents.push({ entityId: e.id, name: e.name, type: e.type, degree: 0, origin: 'user' })
    for (const t of kb.triples) trips.push({ subject: t.subjectId, object: t.objectId, relation: t.predicate, origin: 'user' })
    // 度数在**合并后**重算（自建边也计入）
    const deg = new Map<string, number>()
    for (const t of trips) {
      deg.set(t.subject, (deg.get(t.subject) ?? 0) + 1)
      deg.set(t.object, (deg.get(t.object) ?? 0) + 1)
    }
    for (const e of ents) e.degree = deg.get(e.entityId) ?? 0
    void degree
    overviewCache = {
      entities: ents,
      triples: trips,
      relationTypes: rels.map((r) => r.name),
      loadedMs: Date.now() - t0,
    }
    return overviewCache
  } finally { d.close() }
}

/**
 * U3：把**当前就绪的嵌入服务**包成 embedder 交给 user-kb。
 * 🔴 没就绪就返回 null —— user-kb 会保存成功但标「待索引」，**不静默降级**。
 */
function kbEmbedder(): Embedder | null {
  const emb = state.services.find((s) => s.role === 'embedding' && s.state === 'ready' && s.port)
  if (!emb || !emb.port) return null
  const port = emb.port
  return {
    modelId: USER_VECTOR_MODEL,
    embed: (texts: string[]) => embed(texts, { port, timeoutMs: 30000 }),
  }
}

/**
 * U1：知识库请求的**薄接线**。三条纪律：
 *   · 业务一律在 user-kb.ts（本文件不碰它的库句柄）；
 *   · 🔴 **日志只记 op 与 id/code，绝不记用户正文**（用户内容只许存在 user_data 内）；
 *   · 写入成功后让全貌页缓存失效（U2 起用户实体会进全貌页）。
 */
async function kbOp(port: PortLike, id: number, op: string, mutate: boolean, run: (paths: AppPaths) => unknown | Promise<unknown>): Promise<void> {
  const paths = state.paths
  if (!paths) {
    port.postMessage({ id, kind: 'reply', data: null, error: '后端没有拿到 AppPaths' })
    return
  }
  try {
    const data = await run(paths)
    if (mutate) overviewCache = null
    const obj = (data ?? {}) as Record<string, unknown>
    const key = typeof obj.id === 'string' ? obj.id : typeof obj.revision === 'number' ? obj.revision : ''
    logEvent(paths, { event: 'kb:' + op, ok: true, key })
    port.postMessage({ id, kind: 'reply', data })
  } catch (err) {
    const e = err as KbError
    const code = e && typeof e.code === 'string' ? e.code : 'unknown'
    logEvent(paths, { event: 'kb:op-failed', op, code })
    port.postMessage({ id, kind: 'reply', data: null, error: (err as Error).message })
  }
}

/** 余弦（本项目的向量都做过 L2 归一化 → 点积即余弦） */
function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}

function pathStatus(state: PathStatus['state'], ms: number, error?: string): PathStatus {
  return error ? { state, ms, error } : { state, ms }
}

/** 库外/闲聊问题的确定性闸门：不检索、不调模型、不渲染图（GPU/CPU 一致）。 */
function isOffTopicQuestion(raw: string): boolean {
  const q = raw.trim()
  if (!q) return false
  const arithmetic = /^(?:\d+|[一二三四五六七八九十]+)\s*[+\-*/×÷]\s*(?:\d+|[一二三四五六七八九十]+)\s*(?:=|等于多少|等于几|是多少|等于)?\s*[？?。!！]*$/.test(q)
  if (arithmetic) return true
  const domain = /(船舶|电气|设备|故障|维护|检修|发电机|电动机|继电器|断路器|接触器|PLC|绝缘|电压|电流|电阻|仪表|灭弧|配电|电站|天线|雷达|罗经)/i.test(q)
  const weather = /(天气|气温|下雨|晴天|阴天|温度|weather|forecast|星期几|几号|几点)/i.test(q)
  if (weather && !domain) return true
  return /^(你好|您好|你是谁|谢谢|讲个笑话)[？?！!。]*$/.test(q)
}

function offTopicBundle(question: string): EvidenceBundle {
  const st = pathStatus('skipped', 0, '库外问题：未进入检索')
  return {
    bundleVersion: BUNDLE_VERSION,
    question,
    createdAt: Date.now(),
    status: { text: st, graph: st, diagnostics: st },
    text: { evidences: [] },
    graph: { seeds: [], nodes: [], links: [], causalPaths: [], cooccurrencePaths: [], noPath: true },
    diagnostics: { paths: [] },
    citations: [],
    evidenceLevel: 'insufficient',
    highestSimilarity: null,
    notes: ['库外问题：未进入两路检索（不渲染子图 / 路径 / 共现图）'],
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' 超时（' + ms + ' ms）')), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 跑一次两路检索，交出一份 **EvidenceBundle**（四块 + 引用编号已在包内排好）。
 * ⚠️ 单路超时保险丝只能保护**异步段**（Node 单线程，同步检索段不可抢占）；
 *    实测各路耗时都远小于阈值，实际耗时逐条登记在 bundle.status 与日志里。
 */
async function runRetrieval(paths: AppPaths, question: string, locale: 'zh' | 'en' = 'zh'): Promise<{ bundle: EvidenceBundle; queryVec: number[] }> {
  // 🆕 v0.3.2：按档合并检索配置（`cpu` 覆盖块）—— **GPU 档取顶层原值，一字不动**
  const cfgBase = loadRetrievalConfig(paths)
  const dialNow: Dial = state.dial?.dial ?? 'cuda'
  const cfg = dialConfig(cfgBase, cfgBase.cpu, dialNow)
  const evCfg = loadEvidenceConfig(paths)
  const notes: string[] = []
  // 🆕 v0.3.2：档位 / reranker / 线程 入档（P0-6 + P0-7：不静默、可回溯）
  if (state.dial) {
    notes.push('档位=' + state.dial.dial + '（强制=' + state.dial.forced + '，GPU 检测=' + state.dial.backend + '）')
    notes.push('reranker=' + (state.dial.rerankerEnabled ? '启用（三处打分走）' : '不启用（三处打分不走）'))
    notes.push('线程=' + (state.dial.threads ?? '不注入线程参数（GPU 档保持与 v0.3.1 逐字等价）'))
    notes.push('回答模型=' + state.dial.model)
  } else {
    notes.push('🔴 未收到档位快照（主进程还没下发 dial）→ 检索按顶层配置走，本轮档案缺档位标记')
  }
  const status: Record<PathName, PathStatus> = {
    text: pathStatus('skipped', 0),
    graph: pathStatus('skipped', 0),
    diagnostics: pathStatus('skipped', 0),
  }

  // 问题**只编码一次**，两路共用（A2）
  const emb = state.services.find((s) => s.role === 'embedding' && s.state === 'ready' && s.port)
  if (!emb || !emb.port) throw new Error('Embedding 服务未就绪（role=embedding 没有 ready 端口）→ 无法编码问题')
  const t0 = Date.now()
  const vectors = await embed([question], { port: emb.port, timeoutMs: cfg.common.pathTimeoutMs })
  const queryVec = vectors[0]
  if (!queryVec || queryVec.length !== cfg.common.questionVectorDim) {
    throw new Error('问题向量维度不对：期望 ' + cfg.common.questionVectorDim + '，实得 ' + (queryVec ? queryVec.length : 0))
  }

  // ① 文本路 → 图谱路 —— 🔴 **串行**（13- §3.8 定案，负责人拍板：实测 1220 vs 1207 = 0.99×；
  //    且并行时两路报出来的分路耗时一模一样、**都是假的**（都报 891 ms），无法归因、无法记账）
  // 交付物 5：Reranker **接入但默认关闭**（开关在 config/retrieval）；启用了却没有 ready 端口也**不静默**
  const reranker = cfg.reranker.enabled
    ? state.services.find((s) => s.role === 'reranker' && s.state === 'ready' && s.port)
    : undefined
  if (cfg.reranker.enabled && (!reranker || !reranker.port)) {
    notes.push('Reranker 配置为启用，但没有 ready 端口 → 三处打分按未启用处理（不静默）')
    logEvent(paths, { event: 'retrieval:reranker-unavailable' })
  }
  // 🆕 U4：载入**用户自建图层**（只读 user_data/user-kb.sqlite；教材三库与 data/graph 一个字不动）
  let kbSnap: UserKbSnapshot | null = null
  let kbVec: { texts: Map<string, Float32Array>; entities: Map<string, Float32Array> } | null = null
  try {
    kbSnap = listUserKb(paths, storeDb(paths, 'graph'))
    kbVec = kbSnap.revision > 0 ? loadUserVectors(paths) : { texts: new Map(), entities: new Map() }
  } catch (err) {
    notes.push('用户知识库读取失败（已跳过，不影响内置知识库检索）：' + (err as Error).message)
    logEvent(paths, { event: 'kb:load-failed', code: 'read' })
  }
  const userKbCfg = cfg.userKb ?? { textK: 1, textMinScore: 0.35 }

  const rerankPort = reranker && reranker.port ? reranker.port : 0
  // 🔴 打分**共用预算**（14- §3.3 超时账；负责人 2026-10-11 拍板「可以共用，推荐测试，然后放宽」）：
  //    文本路只有一处打分 → 独自用满这一个预算；
  //    图谱路有**两处**打分（种子 + 通路）→ 进图谱路时取一次 deadline，两处共用，
  //    这样最坏也不会撞上单路 pathTimeoutMs 把整条路杀掉（打分失败绝不能把「能回答」变成「不能回答」）。
  const rerankBudgetMs = Math.max(1, cfg.common.rerankBudgetMs ?? 2500)
  const textArgs = { chunkDb: storeDb(paths, 'chunk'), question, queryVec, config: cfg.text }
  const textPool = Math.max(1, cfg.text.rerankPool ?? 5)
  const tText = Date.now()
  const textR = await withTimeout(
    (async () => {
      if (locale === 'en') return retrieveTextEn(textArgs)
      if (rerankPort <= 0) return retrieveText(textArgs)
      return retrieveTextWithRerank(
        textArgs,
        (q, docs) => rerank(q, docs, { port: rerankPort, timeoutMs: rerankBudgetMs, topN: docs.length }),
        textPool,
      )
    })(),
    cfg.common.pathTimeoutMs,
    '文本路',
  ).then(
    (r) => {
      status.text = pathStatus('ok', Date.now() - tText)
      // P0-7 留痕（13- §3.11）：池 / 实际重排条数 / 耗时 / 是否兜底；档位字段留批 1（档位通道未做）
      const tr = r as { reranked?: number; rerankMs?: number; rerankFallback?: boolean; rerankError?: string }
      if (typeof tr.rerankFallback === 'boolean') {
        if (tr.rerankFallback) {
          notes.push('文本路打分兜底（退回原序，不影响出答案）：' + (tr.rerankError ?? '未知原因') + '（池' + textPool + '/' + (tr.rerankMs ?? 0) + 'ms）')
          logEvent(paths, { event: 'retrieval:text-rerank-fallback', message: tr.rerankError ?? '', ms: tr.rerankMs ?? 0 })
        } else {
          notes.push('文本路打分：池' + textPool + '/重排' + (tr.reranked ?? 0) + '条/' + (tr.rerankMs ?? 0) + 'ms')
          logEvent(paths, { event: 'retrieval:text-reranked', reranked: tr.reranked ?? 0, ms: tr.rerankMs ?? 0 })
        }
      }
      return r
    },
    (e) => {
      const m = (e as Error).message
      status.text = pathStatus(/超时/.test(m) ? 'timeout' : 'failed', Date.now() - tText, m)
      notes.push('文本路失败（已降级）：' + m)
      logEvent(paths, { event: 'retrieval:text-failed', message: m })
      return null
    },
  )

  const tGraph = Date.now()
  // 🆕 打分注入：deadline 在**进图谱路这一刻**取，两处打分共用
  const graphRerank =
    rerankPort > 0
      ? {
          deadline: Date.now() + rerankBudgetMs,
          fn: (q: string, docs: string[], timeoutMs: number) =>
            rerank(q, docs, { port: rerankPort, timeoutMs: Math.max(1, Math.min(timeoutMs, rerankBudgetMs)), topN: docs.length }),
        }
      : null
  // 🆕 2026-10-19：消融开关 `graph.enabled`（默认 true）。false = 只跑文本路（no_graph 臂），
  //    图路与诊断直接留空、状态保持 skipped，并在 notes 里留痕（不静默）。
  const graphR = (cfg.graph as { enabled?: boolean }).enabled === false
    ? (notes.push('图路已按配置关闭（graph.enabled=false，消融臂）'), null)
    : await withTimeout(
    retrieveGraph({
      graphDb: storeDb(paths, 'graph'),
      chunkDb: storeDb(paths, 'chunk'),
      question,
      queryVec,
      config: cfg.graph,
      diagnostics: cfg.diagnostics,
      rerank: graphRerank,
      // 🆕 U4：**逻辑合并**（内存）—— 端点/向量由 qa-core 注入
      userGraph: kbSnap
        ? { entities: kbSnap.entities.map((e) => ({ id: e.id, name: e.name, type: e.type, aliases: e.aliases })), triples: kbSnap.triples, entityVec: (kbVec ? kbVec.entities : new Map()) }
        : null,
      userRev: kbSnap ? kbSnap.revision : 0,
    }),
    cfg.common.pathTimeoutMs,
    '图路',
  ).then(
    (r) => {
      status.graph = pathStatus('ok', Date.now() - tGraph)
      status.diagnostics = pathStatus('ok', Date.now() - tGraph)
      if (r && r.rerankNotes.length > 0) {
        for (const n of r.rerankNotes) notes.push(n) // P0-7：档位字段留批 1（档位通道未做），本轮只记 池/条数/耗时/兜底
        logEvent(paths, { event: 'retrieval:graph-reranked', notes: r.rerankNotes })
      }
      return r
    },
    (e) => {
      const m = (e as Error).message
      const st = pathStatus(/超时/.test(m) ? 'timeout' : 'failed', Date.now() - tGraph, m)
      status.graph = { ...st }
      status.diagnostics = { ...st }
      notes.push('图路失败（已降级）：' + m)
      logEvent(paths, { event: 'retrieval:graph-failed', message: m })
      return null
    },
  )

  // -------------------------------------------------------------------------
  // 🆕 U4：把**用户自建文本**逻辑并入文本证据（教材证据一条不动；空知识库 = 完全不变）
  //   尺子只用**向量余弦**（没有向量的文本进不来 —— 界面已标「待索引」，不静默）
  //   三档充足度的尺子仍按 §A8 = **教材**最像子块余弦，这里不掺和
  // -------------------------------------------------------------------------
  const userEv: TextEvidence[] = []
  if (kbSnap && kbVec && userKbCfg.textK > 0) {
    const scored = kbSnap.texts
      .map((t) => {
        const v = kbVec ? kbVec.texts.get(t.id) : undefined
        return { t, score: v ? dot(queryVec, v) : Number.NEGATIVE_INFINITY }
      })
      .filter((x) => x.score >= userKbCfg.textMinScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, userKbCfg.textK)
    for (const x of scored) {
      // 🔴 v1.2：用户自建文本的标题与来源备注走**专有字段**（title / sourceNote），
      //    不再借用 chapter / section —— 来源定位字段已整体移除。
      userEv.push({
        chunkId: x.t.id,
        kind: 'user',
        text: x.t.text,
        matches: [],
        score: x.score,
        title: x.t.title || null,
        sourceNote: x.t.sourceNote,
      })
      notes.push('文本证据含用户自建文本 ' + x.t.id + '（余弦 ' + x.score.toFixed(4) + '，来源=用户录入）')
      logEvent(paths, { event: 'retrieval:user-text', id: x.t.id, score: Number(x.score.toFixed(4)) })
    }
    if (userEv.length > 0) notes.push('用户自建文本并入 ' + userEv.length + ' 条（语料证据不受影响）')
    const pending = kbSnap.pendingIndex ?? 0
    if (pending > 0) notes.push('用户知识库还有 ' + pending + ' 条**待索引**（无向量 → 检索不到；可在「知识管理」页点「重建索引」）')
  }

  // A8：证据充足度三档 —— 尺子 = **文本路最像子块余弦**
  const highest = textR ? textR.topSimilarity : null
  const level: EvidenceLevel =
    highest === null
      ? 'insufficient'
      : highest >= evCfg.sufficiency.sufficient
        ? 'sufficient'
        : highest >= evCfg.sufficiency.partial
          ? 'partial'
          : 'insufficient'
  if (highest === null) notes.push('文本路没给出相似度 → 充足度按「不足」处理（不静默）')

  const bundle: EvidenceBundle = {
    bundleVersion: BUNDLE_VERSION,
    question,
    createdAt: Date.now(),
    status,
    text: { evidences: [...(textR ? textR.evidences : []), ...userEv] },
    graph: {
      seeds: graphR ? graphR.seeds : [],
      nodes: graphR ? graphR.nodes : [],
      links: graphR ? graphR.links : [],
      causalPaths: graphR ? graphR.causalPaths : [],
      cooccurrencePaths: graphR ? graphR.cooccurrencePaths : [],
      noPath: graphR ? graphR.noPath : true,
    },
    diagnostics: { paths: graphR ? graphR.diagnostics : [] },
    citations: [],
    evidenceLevel: level,
    highestSimilarity: highest,
    notes,
  }
  if (graphR && graphR.noPath) notes.push('图路 no_path：没找到路径，已退化为「实体 + 证据块」（不硬造）')
  const pairMissing = (graphR ? graphR.diagnostics : []).filter((p) => p.pairMissing).length
  if (pairMissing > 0) notes.push('诊断路径中 ' + pairMissing + ' 条「原因→措施」配对缺失（并列展示、不强配）')
  notes.push('端到端检索耗时 ' + (Date.now() - t0) + ' ms')
  logEvent(paths, {
    event: 'retrieval:done',
    ms: Date.now() - t0,
    evidenceLevel: level,
    highest: highest,
    text: status.text,
    graph: status.graph,
    textEvidences: bundle.text.evidences.length,
    nodes: bundle.graph.nodes.length,
    links: bundle.graph.links.length,
    diagnostics: bundle.diagnostics.paths.length,
  })
  return { bundle: assignCitations(bundle), queryVec: Array.from(queryVec) }
}

/** 一条链路：把请求发给 llama-server，按批把 token 回传，支持中途取消 */
async function runChat(port: PortLike, req: ChatReq): Promise<void> {
  const fail = (kind: string, message: string): void => {
    errorText = message
    finishedStatus = 'error'
    port.postMessage({ id: req.id, kind: 'chat.error', sessionId: req.sessionId, assistantMessageId: req.assistantMessageId, error: { kind, message } })
  }

  const paths = state.paths
  if (!paths) return fail('no-paths', '后端没有拿到 AppPaths（主进程注入失败）')
  const locale: 'zh' | 'en' = (req as unknown as { locale?: string }).locale === 'en' ? 'en' : 'zh'
  const svc = state.service
  if (!svc || svc.state !== 'ready' || !svc.port) {
    return fail('not-ready', '模型服务尚未就绪，无法生成回答。可在顶部状态条点「重试」。')
  }
  const answer = state.answer
  if (!answer) return fail('no-config', '后端没有拿到模型参数（主进程未下发 config）')

  let prompts: PromptsConfig
  let systemPrompt = ''
  let evCfg: EvidenceConfig | null = null
  try {
    prompts = loadPrompts(paths)
    if (locale === 'en') prompts = { ...prompts, ...EN_PROMPTS }
    systemPrompt = locale === 'en' ? EN_PROMPTS.system : buildSystemPrompt(prompts)
    evCfg = loadEvidenceConfig(paths)
  } catch (err) {
    return fail('prompts', (err as Error).message)
  }

  const past = state.history.get(req.sessionId) ?? []
  const history: ChatMessage[] = [...past, { role: 'user', content: req.userMessage.content }]
  const historyOpts = { historyTurns: answer.historyTurns, historyCharLimit: answer.historyCharLimit }

  // 目标 4 · 4.5：**先检索、再组装**。检索整体失败**不静默**：记日志 + 退回纯对话口径（目标 1 口径）
  let bundle: EvidenceBundle | null = null
  // ── 目标 5 · 5.1：本轮档案采集（时间线 / 判断清单 / SSE / 查询向量）──
  const turnStart = Date.now()
  const turnStartIso = new Date(turnStart).toISOString()
  const timeline: TimelineStep[] = []
  const judgments: Judgment[] = []
  const sseLines: string[] = []
  let queryVec: number[] | null = null
  const mark = (step: string, start: number, end: number, note?: string): void => {
    timeline.push(note ? { step, start, end, ms: end - start, note } : { step, start, end, ms: end - start })
  }
  const retStart = Date.now()
  const offTopic = isOffTopicQuestion(req.userMessage.content)
  if (offTopic) {
    bundle = offTopicBundle(req.userMessage.content)
    logEvent(paths, { event: 'retrieval:off-topic', question: req.userMessage.content.slice(0, 120) })
    mark('库外问题：跳过检索', retStart, Date.now(), '不调模型 / 不渲染子图·路径·共现图')
  } else {
    try {
      const rr = await runRetrieval(paths, req.userMessage.content, locale)
      bundle = rr.bundle
      if (locale === 'en') {
        bundle = mapBundleEn(bundle, { chunkDb: storeDb(paths, 'chunk'), graphDb: storeDb(paths, 'graph') })
      }
      queryVec = rr.queryVec
    } catch (err) {
      const m = (err as Error).message
      logEvent(paths, { event: 'retrieval:failed', message: m })
      console.warn('[qa-core] 检索失败，退回纯对话口径：' + m)
    }
    mark('问题编码 + 两路检索（文本∥图→诊断）', retStart, Date.now(), bundle ? undefined : '检索失败，已退回纯对话口径')
  }

  const promptStart = Date.now()
  // §2.4.4「不足」档：**拒答 + 改进建议**（不调模型 —— 不给它编造的机会）
  const noEvidence =
    bundle !== null && bundle.evidenceLevel === 'insufficient' && bundle.text.evidences.length === 0
  const messages: ReturnType<typeof buildMessages> = noEvidence
    ? []
    : bundle !== null
      ? (locale === 'en'
          ? (buildGroundedMessagesEn(bundle, history, historyOpts) as unknown as ReturnType<typeof buildMessages>)
          : buildGroundedMessages(bundle, history, historyOpts, prompts, evCfg as EvidenceConfig))
      : (locale === 'en'
          ? (buildPlainMessagesEn(history, historyOpts) as unknown as ReturnType<typeof buildMessages>)
          : buildMessages(history, historyOpts, systemPrompt))

  mark('组装提示词（七段）', promptStart, Date.now(), noEvidence ? '拒答短路：本轮不调模型' : undefined)

  // ── 判断清单（「卡一刀」的输入 → 规则 → 结论；供档案 ⑭ 块）──
  if (bundle) {
    judgments.push({
      input: '文本路最像子块余弦 ' + (bundle.highestSimilarity === null ? '（无）' : bundle.highestSimilarity.toFixed(4)),
      rule: '≥0.6 充足 / 0.4–0.6 部分 / <0.4 不足（阈值未标定）',
      result: ({ sufficient: '充足', partial: '部分', insufficient: '不足' } as Record<string, string>)[bundle.evidenceLevel] ?? bundle.evidenceLevel,
      degraded: bundle.evidenceLevel === 'insufficient',
    })
    judgments.push({
      input: '原文证据 ' + bundle.text.evidences.length + ' 条',
      rule: '档位=不足 且 0 条 → 拒答短路（不调模型）',
      result: noEvidence ? '拒答（不调模型）' : '正常生成',
      degraded: noEvidence,
    })
    judgments.push({
      input: '子图 ' + bundle.graph.nodes.length + ' 节点 / ' + bundle.graph.links.length + ' 边',
      rule: '节点 ≤2 或 边=0 → 界面不画图（整块不显示）',
      result: (bundle.graph.nodes.length <= 2 || bundle.graph.links.length === 0) ? '不显示' : '显示',
    })
    const pairMiss = bundle.diagnostics.paths.filter((x) => x.pairMissing).length
    judgments.push({
      input: '图上通路 ' + bundle.graph.causalPaths.length + ' 条 ｜ 诊断路径 ' + bundle.diagnostics.paths.length + ' 条（配对缺失 ' + pairMiss + '）',
      rule: '图上通路 0 条 → 不画路径图；树节点 ≤2 → 不画树；配对缺失则原因与措施并列、不强配',
      result: (bundle.graph.causalPaths.length === 0 ? '路径图不显示' : '路径图显示') + ' ｜ ' + (pairMiss > 0 ? '含配对缺失（并列展示）' : '全部已配对'),
    })
    const failed = (Object.keys(bundle.status) as PathName[]).filter((k) => bundle.status[k].state !== 'ok')
    judgments.push({
      input: '逐路状态 ' + (Object.keys(bundle.status) as PathName[]).map((k) => k + '=' + bundle.status[k].state).join(' / '),
      rule: '任一路 failed/timeout → 面板留一行提示（不静默降级）',
      result: failed.length === 0 ? '四路全 ok' : (failed.join(' / ') + ' 异常'),
      degraded: failed.length > 0,
    })
  }

  // 目标 2.5：**先落库、再生成** —— 崩溃也不会丢掉提问（用户消息 + status=streaming 的助手消息）
  const d = openDb(paths)
  const startedAt = Date.now()
  let finishedStatus = 'done'
  let errorText: string | null = null
  try {
    ensureSession(d, req.sessionId, req.userMessage.createdAt)
    upsertMessage(d, req.sessionId, { id: req.userMessage.id, role: 'user', content: req.userMessage.content, createdAt: req.userMessage.createdAt, status: 'done' }, nextSeq(d, req.sessionId))
    upsertMessage(d, req.sessionId, { id: req.assistantMessageId, role: 'assistant', content: '', createdAt: startedAt, status: 'streaming' }, nextSeq(d, req.sessionId))
    d.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(startedAt, req.sessionId)
  } catch (err) {
    logEvent(paths, { event: 'db:chat-start-failed', message: (err as Error).message })
  }

  const controller = new AbortController()
  state.inflight.set(req.id, controller)
  let aborted = false

  let full = ''
  let pending = ''
  let firstTokenAt: number | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    if (timer) { clearTimeout(timer); timer = null }
    if (!pending) return
    const text = pending
    pending = ''
    port.postMessage({ id: req.id, kind: 'chat.delta', sessionId: req.sessionId, assistantMessageId: req.assistantMessageId, text })
  }
  const onPiece = (piece: string): void => {
    if (firstTokenAt === null) firstTokenAt = Date.now()
    full += piece
    pending += piece
    if (pending.length >= BATCH_CHARS) flush()
    else if (!timer) timer = setTimeout(flush, BATCH_MS)
  }

  logEvent(paths, {
    event: 'backend:chat-start',
    id: req.id,
    sessionId: req.sessionId,
    port: svc.port,
    msgs: messages.length,
    noEvidence,
    retrieval: bundle ? bundle.status : null,
  })
  try {
    if (noEvidence) {
      full = prompts.noEvidence
      logEvent(paths, {
        event: 'backend:refuse',
        reason: '证据不足（三档：不足）且无原文证据',
        highest: bundle ? bundle.highestSimilarity : null,
      })
      port.postMessage({ id: req.id, kind: 'chat.delta', sessionId: req.sessionId, assistantMessageId: req.assistantMessageId, text: full })
      port.postMessage({ id: req.id, kind: 'chat.done', sessionId: req.sessionId, assistantMessageId: req.assistantMessageId, evidence: bundle })
      return
    }
    const genStart = Date.now()
    const res = await fetch('http://127.0.0.1:' + svc.port + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        stream: true,
        max_tokens: answer.n,
        temperature: answer.temperature,
        top_p: answer.topP,
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return fail('http', '模型服务返回 HTTP ' + res.status + (text ? '：' + text.slice(0, 200) : ''))
    }
    if (!res.body) return fail('no-body', '模型服务没有返回流式响应体。')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let sseDone = false
    while (!sseDone) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (sseLines.length < 5000) sseLines.push(line)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') { sseDone = true; break }
        try {
          const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }
          const piece = parsed.choices?.[0]?.delta?.content
          if (piece) onPiece(piece)
        } catch {
          /* 半个 JSON：等下一块 */
        }
      }
    }
    flush()
    mark('模型生成（流式）', genStart, Date.now(), firstTokenAt ? '首字 ' + (firstTokenAt - genStart) + ' ms' : '未收到首字')
    port.postMessage({ id: req.id, kind: 'chat.done', sessionId: req.sessionId, assistantMessageId: req.assistantMessageId, evidence: bundle })
    logEvent(paths, { event: 'backend:chat-done', id: req.id, chars: full.length })
  } catch (err) {
    flush()
    if ((err as Error).name === 'AbortError') {
      aborted = true
      // 用户点了「停止」：不是错误，已生成的部分照常定稿
      port.postMessage({ id: req.id, kind: 'chat.done', sessionId: req.sessionId, assistantMessageId: req.assistantMessageId, evidence: bundle })
      logEvent(paths, { event: 'backend:chat-aborted', id: req.id, chars: full.length })
    } else {
      fail('network', '连接模型服务失败：' + (err as Error).message)
      logEvent(paths, { event: 'backend:chat-error', id: req.id, message: (err as Error).message })
    }
  } finally {
    if (timer) clearTimeout(timer)
    state.inflight.delete(req.id)
    // 目标 2.5：定稿落库（内容 / 状态 / 首字 / 结束时间 / 错误）
    try {
      finalizeAssistant(d, req.assistantMessageId, { content: full, status: finishedStatus, firstTokenAt, finishedAt: Date.now(), error: errorText })
    } catch (err) {
      logEvent(paths, { event: 'db:finalize-failed', message: (err as Error).message })
    }
    // 目标 5 · D28：证据包落库（**旁路**：失败只记日志，不影响回答）
    if (bundle) {
      try {
        saveMessageEvidence(d, req.sessionId, req.assistantMessageId, bundle.bundleVersion, bundle)
      } catch (err) {
        logEvent(paths, { event: 'db:evidence-failed', message: (err as Error).message })
      }
    }
    // 本轮问答记进历史（2.5 起改为写 sessions.sqlite）
    if (full) {
      state.history.set(req.sessionId, [...history, { role: 'assistant', content: full }])
    } else {
      state.history.set(req.sessionId, history)
    }

    // ── 目标 5 · 5.1：写「每轮问答档案」（决策 D26）────────────────────────────
    // 🔴 **旁路**：任何失败只记 app.log —— 不弹窗、不中断回答、不降级检索。
    try {
      const fin = Date.now()
      mark('定稿落库 + 收尾', fin - 1, fin, aborted ? '用户中途停止（已生成部分照常定稿）' : undefined)
      const lc = loadLoggingConfig(paths)
      if (lc.missing) logEvent(paths, { event: 'archive:config-missing', file: join(paths.configDir, 'logging', 'default.json'), using: '文档默认值 enabled=true' })
      if (lc.error) logEvent(paths, { event: 'archive:config-bad', message: lc.error })
      if (!lc.cfg.archive.enabled) {
        logEvent(paths, { event: 'archive:disabled' })
      } else {
        const res = writeTurnArchive(paths, lc.cfg, {
          question: req.userMessage.content,
          sessionId: req.sessionId,
          assistantMessageId: req.assistantMessageId,
          userMessageId: req.userMessage.id,
          turnIndex: Math.floor(past.length / 2) + 1,
          isFirst: past.length === 0,
          stopped: aborted,
          modelRegenerate: false,
          startedAt: turnStart,
          finishedAt: fin,
          status: finishedStatus,
          error: errorText,
          timeline,
          judgments,
          queryVector: queryVec,
          bundle,
          prompt: messages.length > 0
            ? {
                // 🔴 七段在**最后一条 user** 里（前面是历史轮次）—— 取错就会只记到历史提问
                system: messages[0].content,
                user: messages[messages.length - 1].content,
                systemChars: messages[0].content.length,
                userChars: messages[messages.length - 1].content.length,
                messageCount: messages.length,
              }
            : null,
          model: {
            port: svc.port,
            params: { temperature: answer.temperature, top_p: answer.topP, max_tokens: answer.n, stream: true },
          },
          sse: sseLines,
          answer: full,
          appLogSince: turnStartIso,
        })
        if (res.error) logEvent(paths, { event: 'archive:failed', message: res.error })
        else logEvent(paths, { event: 'archive:written', file: res.file })
      }
    } catch (err) {
      logEvent(paths, { event: 'archive:exception', message: (err as Error).message })
    }
  }
}

/** 分发一条消息；`port` 是回话用的端口（渲染进程转交的端口，或 parentPort） */
function handleMessage(port: PortLike, data: unknown): void {
  const msg = data as { kind?: string } | null
  if (!msg || typeof msg.kind !== 'string') return
  const paths = state.paths

  if (msg.kind === 'service') {
    const ctl = msg as unknown as ServiceCtl
    state.service = ctl.status
    state.services = ctl.services ?? [ctl.status]
    if (ctl.answer) state.answer = ctl.answer
    // 🆕 v0.3.2：收到档位快照（检索按档取配置、档案按档记参数）
    if (ctl.dial) state.dial = ctl.dial
    if (paths) {
      logEvent(paths, {
        event: 'backend:service',
        state: ctl.status.state,
        port: ctl.status.port,
        hasAnswer: Boolean(ctl.answer),
        dial: ctl.dial?.dial,
        threads: ctl.dial?.threads ?? null,
        answerModel: ctl.dial?.model,
        rerankerEnabled: ctl.dial?.rerankerEnabled,
        services: state.services.map((s) => s.role + '=' + s.state + (s.port ? ':' + s.port : '')),
      })
    }
    return
  }
  if (msg.kind === 'chat') {
    void runChat(port, msg as unknown as ChatReq)
    return
  }
  if (msg.kind === 'abort') {
    const r = msg as unknown as AbortReq
    const c = state.inflight.get(r.targetId)
    if (c) {
      c.abort()
      if (paths) logEvent(paths, { event: 'backend:abort', targetId: r.targetId })
    }
    return
  }
  if (msg.kind === 'graph.overview') {
    // 目标 5 · ①（D27）：全貌页数据 —— 读库 + 内存缓存；失败**明确回错**（不静默）
    const req = msg as unknown as { id: number }
    if (!paths) {
      port.postMessage({ id: req.id, kind: 'reply', data: null, error: '后端没有拿到 AppPaths' })
      return
    }
    try {
      const raw = graphOverview(paths)
      const data = (msg as unknown as { locale?: string }).locale === 'en'
        ? mapGraphOverviewEn(raw, storeDb(paths, 'graph'))
        : raw
      logEvent(paths, { event: 'graph:overview', entities: data.entities.length, triples: data.triples.length, loadedMs: data.loadedMs })
      port.postMessage({ id: req.id, kind: 'reply', data })
    } catch (err) {
      logEvent(paths, { event: 'graph:overview-failed', message: (err as Error).message })
      port.postMessage({ id: req.id, kind: 'reply', data: null, error: (err as Error).message })
    }
    return
  }
  // U1 用户知识库：7 个请求（list + 文本/实体/三元组 × save/delete）
  if (msg.kind.startsWith('kb.')) {
    // ⚠️ id = 请求 id（number）；要删除的对象 id 走 targetId（string）—— 两者不可混用
    const req = msg as unknown as { id: number; kind: string; targetId?: string; input?: unknown }
    const graphDb = (p: AppPaths): string => storeDb(p, 'graph')
    const go = (op: string, mutate: boolean, fn: (p: AppPaths) => unknown | Promise<unknown>): void => {
      void kbOp(port, req.id, op, mutate, fn)
    }
    if (req.kind === 'kb.list') return go('list', false, (p) => listUserKb(p, graphDb(p)))
    if (req.kind === 'kb.text.save') return go('text-save', true, (p) => saveUserText(p, req.input as UserTextInput, kbEmbedder()))
    if (req.kind === 'kb.text.delete') return go('text-delete', true, (p) => deleteUserText(p, String(req.targetId)))
    if (req.kind === 'kb.entity.save') return go('entity-save', true, (p) => saveUserEntity(p, graphDb(p), req.input as UserEntityInput, kbEmbedder()))
    if (req.kind === 'kb.entity.delete') return go('entity-delete', true, (p) => deleteUserEntity(p, String(req.targetId)))
    if (req.kind === 'kb.triple.save') return go('triple-save', true, (p) => saveUserTriple(p, graphDb(p), req.input as UserTripleInput))
    if (req.kind === 'kb.triple.delete') return go('triple-delete', true, (p) => deleteUserTriple(p, String(req.targetId)))
    if (req.kind === 'kb.reindex') return go('reindex', true, (p) => reindexUserKb(p, kbEmbedder()))
    return
  }
  if (msg.kind === 'session.list' || msg.kind === 'session.save' || msg.kind === 'session.delete' || msg.kind === 'session.clear') {
    const req = msg as unknown as SessionReq
    if (!paths) {
      port.postMessage({ id: req.id, kind: 'reply', data: null })
      return
    }
    try {
      const d = openDb(paths)
      let data: unknown = null
      if (req.kind === 'session.list') data = listSessions(d, (msg as unknown as { locale?: string }).locale === 'en' ? 'en' : 'zh', storeDb(paths, 'chunk'), storeDb(paths, 'graph'))
      else if (req.kind === 'session.save') { saveSession(d, req.session); data = { ok: true } }
      else if (req.kind === 'session.delete') { d.prepare('DELETE FROM sessions WHERE id = ?').run(req.sessionId); data = { ok: true } }
      else { d.prepare('DELETE FROM messages').run(); d.prepare('DELETE FROM sessions').run(); data = { ok: true } }
      port.postMessage({ id: req.id, kind: 'reply', data })
    } catch (err) {
      logEvent(paths, { event: 'db:op-failed', op: msg.kind, message: (err as Error).message })
      port.postMessage({ id: req.id, kind: 'reply', data: null, error: (err as Error).message })
    }
    return
  }
  if (msg.kind === 'renderer-ready') {
    if (paths) logEvent(paths, { event: 'backend:renderer-ready', port: 'transferred' })
    return
  }
}

/** 在 utilityProcess 里被 fork 时自动执行：接 parentPort、回报状态、接管渲染进程转交的端口 */
export function startBackendWorker(): void {
  const parent = process.parentPort as unknown as PortLike & { on: (e: 'message', l: (m: { data: unknown; ports?: unknown[] }) => void) => unknown }
  const raw = process.argv[2] ?? ''
  let paths: AppPaths | null = null
  let parseError = ''
  try {
    paths = JSON.parse(raw) as AppPaths
  } catch (err) {
    parseError = (err as Error).message
  }
  state.paths = paths

  const hello: BackendHello = {
    kind: 'hello',
    pid: process.pid,
    injected: paths !== null,
    mode: paths?.mode ?? '(注入失败)',
    appRoot: paths?.appRoot ?? parseError,
    binRoot: paths?.binRoot ?? '',
    runtimeDir: paths?.runtimeDir ?? '',
    electronProbe: probeElectron(),
    moduleProbe: probeBackendModule(),
    argv: process.argv,
  }
  parent.postMessage(hello)
  if (paths) logEvent(paths, { event: 'backend:hello', ...hello })
  // 目标 2.5：启动即开库 —— 把上次崩溃留下的 streaming 残留修掉（不依赖界面是否请求会话）
  if (paths) {
    try {
      openDb(paths)
    } catch (err) {
      logEvent(paths, { event: 'db:open-failed', message: (err as Error).message })
      console.error('[qa-core] 会话库打开失败：' + (err as Error).message)
    }
  }
  console.log('[qa-core] hello → ' + JSON.stringify(hello))

  parent.on('message', (e) => {
    // 主进程可能把**渲染进程的端口**转交过来（MessageChannelMain 的 port1）
    const ports = (e as { ports?: Array<PortLike & { start?: () => void }> }).ports
    if (ports && ports.length > 0) {
      const rp = ports[0]
      try { rp.start?.() } catch { /* 已启动 */ }
      rp.on('message', (m) => handleMessage(rp, m.data))
      if (paths) logEvent(paths, { event: 'backend:renderer-port', ok: true })
      console.log('[qa-core] 渲染进程端口已接入')
    }
    handleMessage(parent, e.data)
  })
  if (paths) {
    logEvent(paths, { event: 'backend:listening', pid: process.pid })
    // 🔴 吞掉的 stdio 流错误计数（不静默）
    const stdio = stdioErrorCount()
    if (stdio.count > 0) logEvent(paths, { event: 'stdio:epipe', count: stdio.count, last: stdio.last })
  }
}

// 🔴 utilityProcess 的 stdout 也是父进程的管道，同样会 EPIPE（2026-10-06 修）：模块顶层先挂兜底
guardStdio()

if (process.parentPort) startBackendWorker()
