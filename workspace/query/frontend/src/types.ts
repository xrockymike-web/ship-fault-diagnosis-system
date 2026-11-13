import type { EvidenceBundle } from '../../shared/types'

export type Role = 'user' | 'assistant'

/** 消息状态（§15.2 缺口 2）：流式中 / 已完成 / 出错 */
export type MessageStatus = 'streaming' | 'done' | 'error'

export interface Message {
  id: string
  role: Role
  content: string
  createdAt: number
  status?: MessageStatus
  /** 客户端计时：第一个非空内容到达的时刻（与目标 0 实测同口径） */
  firstTokenAt?: number
  /** 客户端计时：生成结束的时刻 */
  finishedAt?: number
  /** status === 'error' 时的原因文案 */
  error?: string
  /**
   * 目标 5：本轮**证据包**（A9 五块）。随 `chat.done` 下发，并落 `sessions.sqlite` 的
   * `message_evidence` 表（决策 D28）—— 关掉软件 / 切走会话再回来，**三图与引用仍在**。
   * `null` = 该轮没有证据（纯对话口径 / 老会话）。
   */
  evidence?: EvidenceBundle | null
}

export interface Session {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: Message[]
}

/** 模型服务状态（主进程 → preload → 渲染进程，施工单 §16.6 方案甲） */
export interface ServiceStatus {
  state: 'starting' | 'ready' | 'error'
  port?: number
  message?: string
  logPath?: string
}

/** 模型参数（D-F：经 IPC 下发；完整 schema 在 1.5 定稿） */
export interface ModelsConfig {
  answer: {
    gguf: string
    ctx: number
    ngl: number
    n: number
    enableThinking: boolean
    temperature: number
    topP: number
    historyTurns: number
    historyCharLimit: number
  }
  server: { host: string; port: 'dynamic' | number; portRetry: number }
}

/**
 * 流式对话的**接口契约**（施工单 §17.4）。
 * 1.3 的假数据流、1.5 的真实 SSE、2.2 的 utilityProcess + MessagePort —— **三个实现同一个接口**，
 * 所以每次换底层，界面组件都一行没改。
 */
export interface ChatMessage {
  role: Role
  content: string
}

export interface StreamHandlers {
  onDelta: (text: string) => void
  /** 目标 5：带上本轮证据包（没有则为 null / undefined） */
  onDone: (evidence?: EvidenceBundle | null) => void
  onError: (err: { kind: string; message: string }) => void
}

export interface ChatStream {
  /**
   * `messages` 仍是完整历史（**接口一行没变**，这是 1.3 抽象的意义）；
   * 但 2.2 起后端只取**最后一条**作为本轮提问，历史由后端自己维护（D2-11/D2-13）。
   * `userMessageId`：渲染进程生成的消息 id，后端落库时用它（2.5）。
   */
  start(input: { messages: ChatMessage[]; userMessageId?: string } & StreamHandlers): { abort(): void }
}

// ---------------------------------------------------------------------------
// 目标 2.2：渲染进程 ↔ 后端（utilityProcess）的消息协议（施工单 §4.1）
// 通过 MessagePort 直连：主进程只在启动时把端口转交给渲染进程，**不在数据通路上**
// ---------------------------------------------------------------------------

export interface BackendChatReq {
  id: number
  kind: 'chat'
  sessionId: string
  assistantMessageId: string
  /** 🆕 英文模式：'en' 时后端走英文检索与英文提示词；缺省 = 'zh'（行为不变） */
  locale?: 'zh' | 'en'
  userMessage: { id: string; content: string; createdAt: number }
}

export interface BackendAbortReq {
  id: number
  kind: 'abort'
  targetId: number
}

/** 目标 5 · ①：拉全貌页数据（qa-core 读 graph 库后回包） */
export interface BackendGraphOverviewReq { id: number; kind: 'graph.overview' }
export interface BackendSessionListReq { id: number; kind: 'session.list' }
export interface BackendSessionSaveReq { id: number; kind: 'session.save'; session: Session }
export interface BackendSessionDeleteReq { id: number; kind: 'session.delete'; sessionId: string }
export interface BackendSessionClearReq { id: number; kind: 'session.clear' }

// U1 用户知识库（7 个）：list + 文本/实体/三元组 × save/delete
// ⚠️ `id` = 请求 id（number）；要删的对象 id 走 `targetId`（string），两者不可混用
export interface BackendKbListReq { id: number; kind: 'kb.list' }
export interface BackendKbTextSaveReq { id: number; kind: 'kb.text.save'; input: { id?: string; title?: string; text: string; sourceNote?: string | null } }
export interface BackendKbTextDeleteReq { id: number; kind: 'kb.text.delete'; targetId: string }
export interface BackendKbEntitySaveReq { id: number; kind: 'kb.entity.save'; input: { id?: string; name: string; type: string; aliases?: string[]; description?: string | null } }
export interface BackendKbEntityDeleteReq { id: number; kind: 'kb.entity.delete'; targetId: string }
export interface BackendKbTripleSaveReq { id: number; kind: 'kb.triple.save'; input: { id?: string; subjectId: string; predicate: string; objectId: string; note?: string | null } }
export interface BackendKbTripleDeleteReq { id: number; kind: 'kb.triple.delete'; targetId: string }
/** 🆕 U3：把还没有向量的文本/实体补上（嵌入模型就绪后用） */
export interface BackendKbReindexReq { id: number; kind: 'kb.reindex' }

export type BackendReq =
  | BackendGraphOverviewReq
  | BackendChatReq
  | BackendAbortReq
  | BackendSessionListReq
  | BackendSessionSaveReq
  | BackendSessionDeleteReq
  | BackendSessionClearReq
  | BackendKbListReq
  | BackendKbTextSaveReq
  | BackendKbTextDeleteReq
  | BackendKbEntitySaveReq
  | BackendKbEntityDeleteReq
  | BackendKbTripleSaveReq
  | BackendKbTripleDeleteReq
  | BackendKbReindexReq

export interface BackendDeltaEvt {
  id: number
  kind: 'chat.delta'
  sessionId: string
  assistantMessageId: string
  text: string
}

export interface BackendDoneEvt {
  id: number
  kind: 'chat.done'
  sessionId: string
  assistantMessageId: string
  /** 目标 5：qa-core 已在此字段下发证据包（A9）；此前前端没声明、也没用 */
  evidence?: EvidenceBundle | null
}

export interface BackendErrorEvt {
  id: number
  kind: 'chat.error'
  sessionId: string
  assistantMessageId: string
  error: { kind: string; message: string }
}

/** 定长响应（会话 CRUD 等）：与流式事件分开，避免两种语义混在一个通道里 */
export interface BackendReplyEvt {
  id: number
  kind: 'reply'
  data: unknown
  error?: string
}

export type BackendEvt = BackendDeltaEvt | BackendDoneEvt | BackendErrorEvt | BackendReplyEvt

/** 🆕 v0.3.2：档位信息（主进程下发；**渲染进程只读，没有切换档位的入口**） */
export interface DialInfo {
  dial: 'cpu' | 'cuda'
  /** 档位快照（形状见 shared/dial.ts 的 DialSnapshot；这里不引后端类型，保持渲染层解耦） */
  snapshot: unknown | null
  firstTokenMs: number
  totalMs: number
  notice: { cpu: string; waiting: string }
}

export interface ShipAppInfo {
  platform: string
  version: string
  getServiceStatus(): Promise<ServiceStatus>
  onServiceStatus(cb: (s: ServiceStatus) => void): () => void
  restartService(): Promise<ServiceStatus>
  /** 🆕 v0.3.2：取档位 + 按档超时值 + 界面提示语（只读） */
  getDial(): Promise<DialInfo>
  /** 目标 2.2：把请求发给后端进程（utilityProcess，走 MessagePort） */
  sendToBackend(msg: BackendReq): void
  /** 订阅后端事件；返回取消订阅函数 */
  onBackendMessage(cb: (evt: BackendEvt) => void): () => void
  /** 后端端口是否已接入（诊断用） */
  backendReady(): boolean
}

declare global {
  interface Window {
    shipApp?: ShipAppInfo
  }
}
