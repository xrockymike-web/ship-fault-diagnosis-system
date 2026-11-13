/**
 * 双档（GPU / CPU）分档逻辑 —— **单一出处**（2026-10-12 · v0.3.2 · 施工单《双档分档通道与线程注入》）
 *
 * 背景：检索链只有一条，两档共用；两档只在 8 个点上分叉（exe / -ngl / 线程 / reranker 服务 /
 * 三处打分 / 前端首字超时 / 前端总时长 / 界面提示）。本模块管**后 6 个里与"数字"有关的部分**。
 *
 * 三条纪律：
 *   1. 🔴 **不 import `node:`** —— `shared/` 会被前端（渲染进程）打包（先例：`shared/build-tree.ts`）。
 *      核数由**调用方**传入（主进程用 `os.cpus().length`）。
 *   2. 🔴 **顶层值 = GPU 档的值**（D2-结构「丙」）：CPU 档靠 `config/<模块>/default.json` 里的 `cpu`
 *      覆盖块描述差异，**不建 cuda 块**。
 *   3. 🔴 **GPU 档一个线程参数都不注入**（保持与 v0.3.1 逐字等价）。
 */

/** 运行档位（由 GPU 检测结果 + 强制开关裁决得出） */
export type Dial = 'cpu' | 'cuda'

/** 强制档开关的取值 —— 与 `embedding` / `reranker` 的 `backend` 写法完全一致（D25-07） */
export type BackendPref = 'auto' | 'cpu' | 'cuda'

// ---------------------------------------------------------------------------
// 线程
// ---------------------------------------------------------------------------

export interface ThreadPlan {
  /** `-t`：生成线程 */
  t: number
  /** `-tb`：读提示词（prefill）线程 */
  tb: number
  /** 是否追加 `-np 1`（锁单槽） */
  singleSlot: boolean
  /** 来源：auto = 按公式算；override = 配置里写死了 */
  source: 'auto' | 'override'
}

export interface ThreadOptions {
  /** 覆盖 `-t`；null / undefined = 自动 */
  threads?: number | null
  /** 覆盖 `-tb`；null / undefined = 自动 */
  threadsBatch?: number | null
  /** 是否锁单槽（默认 true） */
  singleSlot?: boolean
}

/**
 * CPU 档的线程取值。
 *
 * - `-tb` = **逻辑核数**（19- §5 实测：拐点就在逻辑核 —— tb16 → 505 t/s，tb20 掉 28%、tb24 掉 38%）
 * - `-t`  = **`floor(逻辑核 × 0.75)`**
 *
 * 🔴 为什么是 `0.75 × 逻辑核` 而不是 `min(物理核 × 1.5, 逻辑核)`（负责人 2026-10-12 定）：
 *   Node **拿不到物理核数**，只能调 PowerShell/CIM 去问 Windows —— 那会加启动开销
 *   （本项目刚把冷启动从 6.6 s 优化到 5.2 s），且程序启动时莫名调 PowerShell 容易被 Defender 盯上。
 *   而**在有超线程的机器上两者结果完全相同**（8C16T → 12、6C12T → 9）；
 *   只在**无超线程**机器上偏保守（6C6T → 4 而非 6，宁可选小不过订阅）。
 */
export function resolveThreads(logical: number, opts: ThreadOptions = {}): ThreadPlan {
  const cores = Number.isFinite(logical) && logical > 0 ? Math.floor(logical) : 1
  const autoT = Math.max(1, Math.floor(cores * 0.75))
  const autoTb = Math.max(1, cores)
  const hasT = typeof opts.threads === 'number' && opts.threads > 0
  const hasTb = typeof opts.threadsBatch === 'number' && opts.threadsBatch > 0
  return {
    t: hasT ? Math.floor(opts.threads as number) : autoT,
    tb: hasTb ? Math.floor(opts.threadsBatch as number) : autoTb,
    singleSlot: opts.singleSlot !== false,
    source: hasT || hasTb ? 'override' : 'auto',
  }
}

/** 给 llama-server 的参数片段（**只有 CPU 档才调用它**） */
export function threadArgs(plan: ThreadPlan): string[] {
  const out = ['-t', String(plan.t), '-tb', String(plan.tb)]
  if (plan.singleSlot) out.push('-np', '1')
  return out
}

/** 给档案 / 日志用的一行说明 */
export function describeThreads(plan: ThreadPlan, logical: number): string {
  return '-t ' + plan.t + ' / -tb ' + plan.tb + (plan.singleSlot ? ' / -np 1' : '') +
    '（逻辑核 ' + logical + '，来源=' + (plan.source === 'auto' ? '自动 floor(逻辑核×0.75)' : '配置覆盖') + '）'
}

// ---------------------------------------------------------------------------
// 档位裁决
// ---------------------------------------------------------------------------

/**
 * 强制开关 vs 自动检测：**强制优先**（负责人 2026-10-12 定：配置级开关，**前端不给用户切**）。
 * 测试时由后台改 `config/models` 的 `answer.backend` 来切档。
 */
export function pickDial(pref: BackendPref | undefined, detected: Dial): Dial {
  if (pref === 'cpu' || pref === 'cuda') return pref
  return detected
}

// ---------------------------------------------------------------------------
// CPU 覆盖块合并
// ---------------------------------------------------------------------------

type JsonObject = { [k: string]: unknown }

export function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 把 `cpu` 覆盖块**浅合并**到顶层配置上：顶层键逐个看，两边都是对象就**字段级合并**，否则整体替换。
 *
 * 覆盖块只写「与 GPU 档不同的部分」——
 * 例：`cpu: { answer: { gguf, modelDir }, reranker: { enabled: false } }`
 *     → `answer` 的其他字段（ctx / n / temperature…）原样保留。
 */
export function mergeDialOverride(base: JsonObject, override: unknown): JsonObject {
  if (!isPlainObject(override)) return base
  const out: JsonObject = { ...base }
  for (const [k, v] of Object.entries(override)) {
    const b = out[k]
    out[k] = isPlainObject(b) && isPlainObject(v) ? { ...b, ...v } : v
  }
  return out
}

/** 按档取出真正生效的配置（`cuda` 档 = 顶层原值，一字不动） */
export function dialConfig<T>(base: T, cpuBlock: unknown, dial: Dial): T {
  if (dial !== 'cpu') return base
  return mergeDialOverride(base as unknown as JsonObject, cpuBlock) as unknown as T
}

// ---------------------------------------------------------------------------
// 前端超时（负责人 2026-10-12 定值）
// ---------------------------------------------------------------------------

export interface DialTimeouts {
  /** 首字超时 */
  firstTokenMs: number
  /** 总时长超时 */
  totalMs: number
}

/**
 * - GPU：15 s / 120 s —— **与 v0.3.1 逐字等价，不改**
 * - CPU：45 s / 240 s —— 依据：首字最坏 = 检索 16 s（4×4000 串行，见 retrieval 的
 *   `_overallTimeoutMs_dead_note`）+ prefill 8 s ≈ 24 s，45 s 留 1.9× 余量；
 *   总时长最坏 = 检索 16 s + prefill 8 s + 生成 800 token（max_tokens 硬上限）@漂移后 12 t/s ≈ 67 s ≈ 91 s，240 s 留 2.6×。
 */
export const DIAL_TIMEOUTS: Record<Dial, DialTimeouts> = {
  cuda: { firstTokenMs: 15000, totalMs: 120000 },
  cpu: { firstTokenMs: 45000, totalMs: 240000 },
}

export function timeoutForDial(dial: Dial): DialTimeouts {
  return DIAL_TIMEOUTS[dial] ?? DIAL_TIMEOUTS.cuda
}

/** 界面提示（负责人 2026-10-12 定：两句都要；**只提示、不预测还要等几秒**） */
export const DIAL_NOTICE = {
  cpu: 'CPU 模式，回答较慢',
  waiting: '模型思考 / 检索材料中…',
} as const

// ---------------------------------------------------------------------------
// 档位快照（主进程 → 后端 / 渲染进程的**单一形状**）
// ---------------------------------------------------------------------------

/**
 * `process-manager.dialSnapshot()` 的返回形状；也是下发给 qa-core 与渲染进程的形状。
 * 🔴 走现有的 `service` 消息 / IPC 字段，**不往 EvidenceBundle 加字段**（不碰契约）。
 */
export interface DialSnapshot {
  /** 实际生效的档位 */
  dial: Dial
  /** GPU 检测结果（未受强制开关影响） */
  backend: Dial
  /** 配置文件里的强制开关原值 */
  forced: BackendPref
  /** 本机逻辑核数 */
  logicalCores: number
  /** 已格式化的线程说明；**GPU 档为 null = 不注入任何线程参数** */
  threads: string | null
  /** 结构化线程数值（给档案/数据统计用）；GPU 档为 null */
  threadNums: { t: number; tb: number; singleSlot: boolean } | null
  /** 实际加载的回答模型完整路径 */
  model: string
  /**
   * 🔴 实际生效的 `-ngl`（回答模型）。
   * 档位决定它：CPU 档必须 **0**。漏了这一步会出现「说自己是 CPU 档、其实 -ngl 99 在 GPU 上跑」
   * 的**静默半档**（2026-10-12 首轮 CPU 实测踩到：首字 0.9 s，CPU 不可能这么快）。
   */
  ngl: number
  /** reranker 服务是否启用（受分档影响） */
  rerankerEnabled: boolean
}
