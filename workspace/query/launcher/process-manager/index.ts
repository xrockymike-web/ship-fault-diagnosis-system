/**
 * 模型服务生命周期（目标 2 §16；**目标 2.5 步骤 2.5.3 起为多服务**）。
 *
 * 统一启动 / 监控 / 关闭三个 llama-server 子进程：
 *   · answer    —— 回答模型（GPU 检测 + 无卡弹窗 + 失败重测，逻辑全部沿用目标 2）
 *   · embedding —— Qwen3-Embedding-0.6B：`--embedding --pooling last --embd-normalize 2`
 *   · reranker  —— Qwen3-Reranker-0.6B：`--reranking --pooling rank`
 * 三个服务各自：动态端口、各自日志文件、**就绪后预热调用**、随应用退出清理（不留孤儿）。
 *
 * 四处刻意的设计选择：
 *   1. 本模块自己读 config/models/default.json —— config/ 的 6 个子目录按「哪个模块用、就谁读」分工，
 *      这样不必在**已冻结的模块清单**之外新增模块。
 *   2. 路径全部来自 bootstrap 注入的 AppPaths，本模块只用 join 组合注入的根与配置里的**文件名**（红线）。
 *   3. **不做降级规则**（决策 D25-07「只落能选后端」）：辅助服务默认跟随 GPU 检测结果；要单独走 CPU，
 *      就把该服务的 `backend` 显式写成 'cpu'（开关留给目标 4/6 的降级链用）；**失败不静默切换**。
 *   4. **预热调用**（2026-10-01 决策·甲）：服务就绪后立刻打一次真实请求，使稳态行为从第一次真实调用
 *      开始（实测依据：CUDA 首次 embedding 与之后 余弦 0.99983379，第 2 次起逐位一致）。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createServer } from 'node:net'
import { cpus } from 'node:os'
import { join } from 'node:path'
import type { AppPaths } from '../bootstrap/index'
import { waitForReady } from '../health-check/index'
import { logEvent } from '../diagnostics/index'
// 🆕 v0.3.2：双档分档逻辑的**单一出处**（shared/dial.ts）
import {
  dialConfig,
  describeThreads,
  isPlainObject,
  pickDial,
  resolveThreads,
  threadArgs,
  type BackendPref,
  type Dial,
  type DialSnapshot,
  type ThreadPlan,
} from '../../shared/dial'

export type ServiceState = 'starting' | 'ready' | 'error'
/** 目标 2.5：三个服务角色 */
export type ServiceRole = 'answer' | 'embedding' | 'reranker'

/** 暴露给渲染进程 / 后端的形状（与 preload 的 getServiceStatus 对应；2.5 加 `role` 字段，向后兼容） */
export interface ServiceStatus {
  role: ServiceRole
  state: ServiceState
  port?: number
  message?: string
  logPath?: string
  /** 该服务是否被配置启用（false = 本目标不启动它） */
  enabled?: boolean
}

/** 回答模型的生成参数（qa-core 也要用，故提取为具名类型；2.2 起由主进程下发给后端） */
export interface AnswerConfig {
  gguf: string
  /** 🆕 v0.3.2：模型所在**子目录**（缺省 `answer`；CPU 档指向 `answer-q4km`） */
  modelDir?: string
  /** 🆕 v0.3.2：**强制档开关**（auto｜cpu｜cuda）—— 与 embedding / reranker 同款写法。
   *  🔴 只活在配置文件里，**前端不给用户切**；测试/演示时由后台改它来切档。 */
  backend?: BackendPref
  ctx: number
  /** CPU 模式的层数（0） */
  ngl: number
  /** 检测到可用 CUDA 设备时的层数（99 = 全部卸载到显存） */
  nglGpu: number
  n: number
  enableThinking: boolean
  temperature: number
  topP: number
  historyTurns: number
  historyCharLimit: number
  /** 🆕 v0.3.2：覆盖 `-t`（null/缺省 = 自动 `floor(逻辑核 × 0.75)`）—— **仅 CPU 档生效** */
  threads?: number | null
  /** 🆕 v0.3.2：覆盖 `-tb`（null/缺省 = 自动 逻辑核）—— **仅 CPU 档生效** */
  threadsBatch?: number | null
  /** 🆕 v0.3.2：是否追加 `-np 1` 锁单槽（缺省 = true）—— **仅 CPU 档生效** */
  singleSlot?: boolean
}

/** 辅助服务（embedding / reranker）可指定的后端（D25-07：只落「能选后端」，不做降级规则） */
export type AuxBackend = 'auto' | 'cpu' | 'cuda'

/** 辅助服务配置（目标 2.5 新增；缺字段时按默认值补齐，不静默） */
export interface AuxConfig {
  enabled: boolean
  gguf: string
  ctx: number
  backend: AuxBackend
  /** 池化方式：embedding 用 last，reranker 用 rank（llama-server 实测取值见 §4.1） */
  pooling: string
  /** 仅 embedding：归一化（2 = L2，llama-server 默认） */
  embdNormalize?: number
  /**
   * 🔴 仅 reranker：物理批大小（llama-server 默认 512）。
   * 2026-10-06 **4.5 实测踩到**：rerank 把「问题 + 段落」当**一个序列**处理，
   * 真实段落（父块 ~1000 字 ≈ 700+ token）直接报
   * `input (746 tokens) is too large to process. increase the physical batch size (current batch size: 512)`。
   * → 必须按 ctx 放大，否则**默认关闭的开关一旦打开就是坏的**。
   */
  batchSize?: number
  /** 仅 reranker：物理微批（同上） */
  ubatchSize?: number
  /** 就绪后预热用的固定文本（空 = 不预热） */
  warmup?: string
}

export interface ModelsConfig {
  answer: AnswerConfig
  embedding: AuxConfig
  reranker: AuxConfig
  server: { host: string; port: 'dynamic' | number; portRetry: number }
  /**
   * 🆕 v0.3.2：**CPU 档覆盖块**（D2-结构「丙」）。只写与 GPU 档不同的部分；
   * 顶层值就是 GPU 档的值，**不建 cuda 块**。
   * 🔴 不在这里合并 —— 合并要等后端探测出结果、档位裁决完成之后才做（见 `resolveDial()`）。
   */
  cpu?: Record<string, unknown>
}

/** 读默认配置；缺失或损坏**必须明确报错**，不静默降级（红线） */
export function loadModelsConfig(paths: AppPaths): ModelsConfig {
  const file = join(paths.configDir, 'models', 'default.json')
  if (!existsSync(file)) {
    throw new Error('缺少模型配置：' + file)
  }
  let raw: Partial<ModelsConfig>
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<ModelsConfig>
  } catch (err) {
    throw new Error('模型配置无法解析：' + file + '\n' + (err as Error).message)
  }
  if (!raw.answer || !raw.server) {
    throw new Error('模型配置缺 `answer` 或 `server` 段：' + file)
  }
  const aux = (role: 'embedding' | 'reranker', fallbackPooling: string): AuxConfig => {
    const c = (raw as Record<string, unknown>)[role] as Partial<AuxConfig> | undefined
    if (!c || typeof c.gguf !== 'string' || c.gguf.length === 0) {
      throw new Error('模型配置缺 `' + role + '.gguf`（目标 2.5 起两个辅助模型都必须指名文件名）：' + file)
    }
    return {
      enabled: c.enabled === true,
      gguf: c.gguf,
      ctx: typeof c.ctx === 'number' ? c.ctx : 2048,
      backend: c.backend === 'cpu' || c.backend === 'cuda' ? c.backend : 'auto',
      pooling: typeof c.pooling === 'string' && c.pooling.length > 0 ? c.pooling : fallbackPooling,
      embdNormalize: typeof c.embdNormalize === 'number' ? c.embdNormalize : undefined,
      warmup: typeof c.warmup === 'string' ? c.warmup : undefined,
    }
  }
  return {
    answer: raw.answer,
    embedding: aux('embedding', 'last'),
    reranker: aux('reranker', 'rank'),
    server: raw.server,
    // 🆕 v0.3.2：CPU 档覆盖块**原样透传**。这里**故意不合并** ——
    //   档位要等 detectBackend() 出结果才能裁决，合并留到 ModelServices.resolveDial()。
    cpu: isPlainObject((raw as Record<string, unknown>).cpu)
      ? ((raw as Record<string, unknown>).cpu as Record<string, unknown>)
      : undefined,
  }
}

/** 逻辑核数（🔴 不探测物理核 —— 理由见 shared/dial.ts 的 resolveThreads 注释） */
function safeLogicalCores(): number {
  try {
    const n = cpus().length
    return Number.isFinite(n) && n > 0 ? n : 1
  } catch {
    return 1
  }
}

// ---------------------------------------------------------------------------
// GPU 检测（目标 2 / 步骤 2.6；施工单 §4.4、决策 D2-21）—— 目标 2.5 未改口径
// ---------------------------------------------------------------------------

export type Backend = 'cuda' | 'cpu'

export interface GpuProbeResult {
  backend: Backend
  /** 选定的 -ngl */
  ngl: number
  /** 人类可读的判定理由（进日志与验收证据） */
  reason: string
  /** --list-devices 的原始行（原样留证） */
  deviceLines: string[]
  elapsedMs: number
}

export interface HardwareCache {
  backend: Backend
  ngl: number
  detectedAt: number
  /** **上次警告时的后端**：同机重复启动只弹一次，后端结果变了再弹（D2-21） */
  warnedBackend?: Backend
  deviceLines: string[]
}

export function hardwareCachePath(paths: AppPaths): string {
  return join(paths.runtimeDir, 'hardware.json')
}

export function readHardwareCache(paths: AppPaths): HardwareCache | null {
  const file = hardwareCachePath(paths)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as HardwareCache
  } catch (err) {
    console.warn('[process-manager] hardware.json 解析失败（按无缓存处理）：', (err as Error).message)
    return null
  }
}

function writeHardwareCache(paths: AppPaths, data: HardwareCache): void {
  try {
    mkdirSync(paths.runtimeDir, { recursive: true })
    writeFileSync(hardwareCachePath(paths), JSON.stringify(data, null, 2) + '\n', 'utf8')
  } catch (err) {
    console.warn('[process-manager] 写 hardware.json 失败：', (err as Error).message)
  }
}

/** llama.cpp 自己的日志行长这样：`0.00.000.887 I srv llama_server: initializing ...` —— 不算设备行 */
const LOG_LINE = /^\d+\.\d+\.\d+\.\d+\s+[A-Z]\s/
const DEVICE_HEADER = /^Available devices:/i

/**
 * 跑一次 `--list-devices`（**异步**，不阻塞主进程事件循环）。
 * 2026-09-27 实测教训：`spawnSync` 版把 t1（窗口出现）从 504 ms 抬到 950 ms。
 */
function runListDevices(exe: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let done = false
    let out = ''
    let err = ''
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (status: number | null): void => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve({ status, stdout: out, stderr: err })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(exe, ['--list-devices'], { windowsHide: true, cwd: dirname(exe), stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ status: null, stdout: '', stderr: (e as Error).message })
      return
    }
    timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已退出 */
      }
      finish(null)
    }, 30000)
    child.stdout?.on('data', (d: Buffer) => { out += String(d) })
    child.stderr?.on('data', (d: Buffer) => { err += String(d) })
    child.on('close', (code) => finish(code))
    child.on('error', (e: Error) => { err += e.message; finish(null) })
  })
}

/** 让 **llama.cpp 自己报**能用哪些后端 —— 不靠 WMI / nvidia-smi 猜（§4.4 的理由） */
export async function detectBackend(paths: AppPaths, config: ModelsConfig): Promise<GpuProbeResult> {
  const started = Date.now()
  const cudaExe = join(paths.llamacppDir, 'cuda', 'llama-server.exe')
  if (!existsSync(cudaExe)) {
    return { backend: 'cpu', ngl: config.answer.ngl, reason: '没有 CUDA 版 llama-server：' + cudaExe, deviceLines: [], elapsedMs: Date.now() - started }
  }
  const r = await runListDevices(cudaExe)
  const out = r.stdout
  const err = r.stderr
  const status = r.status
  if (status === null && out.length === 0) {
    return { backend: 'cpu', ngl: config.answer.ngl, reason: 'CUDA 版 --list-devices 起不来：' + (err || '(无输出)'), deviceLines: [], elapsedMs: Date.now() - started }
  }
  const lines = out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0)
  const devices = lines.filter((l) => !DEVICE_HEADER.test(l) && !LOG_LINE.test(l) && l !== '(none)')
  const elapsedMs = Date.now() - started
  if (status === 0 && devices.length > 0) {
    return { backend: 'cuda', ngl: config.answer.nglGpu, reason: 'CUDA 自报设备：' + devices.join(' / '), deviceLines: lines, elapsedMs }
  }
  return {
    backend: 'cpu',
    ngl: config.answer.ngl,
    reason: 'CUDA 版没报出可用设备（退出码 ' + status + (err ? '，stderr：' + err.split('\n')[0].slice(0, 160) : '') + '）',
    deviceLines: lines,
    elapsedMs,
  }
}

/** 读无卡说明文案；**缺文件也要能弹**（写进文案 + 日志，不静默） */
export function readNoGpuNotice(paths: AppPaths): string {
  const file = join(paths.programRoot, 'launcher', 'resources', 'no-gpu-notice.txt')
  if (!existsSync(file)) {
    logEvent(paths, { event: 'gpu:notice-missing', file })
    return '未检测到可用的 NVIDIA 显卡（CUDA）。\n\n程序将以 CPU 模式运行：功能不受影响，但回答速度会变慢。\n\n（说明文件缺失：' + file + '）'
  }
  return readFileSync(file, 'utf8')
}

/** 动态取一个空闲端口（施工单 §16.2） */
function findFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.once('error', reject)
    srv.listen(0, host, () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error('取不到空闲端口'))))
    })
  })
}

interface ProcInfo { pid: number; commandLine: string }

/** 列出本机 llama-server 进程（含命令行）—— 用 PowerShell CIM，无原生依赖 */
function listLlamaProcesses(): ProcInfo[] {
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='llama-server.exe'\" | " +
    'Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (r.status !== 0 || !r.stdout) return []
  const raw = r.stdout.trim()
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    const arr = Array.isArray(parsed) ? parsed : [parsed]
    return (arr as Array<{ ProcessId: number; CommandLine?: string }>).map((x) => ({
      pid: x.ProcessId,
      commandLine: x.CommandLine ?? '',
    }))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// 单个服务
// ---------------------------------------------------------------------------

interface WarmupSpec { path: string; body: unknown }

export interface RoleRuntime {
  role: ServiceRole
  /** 模型的完整路径（由协调者用注入的 modelsDir + 配置里的文件名拼出） */
  modelPath: string
  ctx: number
  ngl: number
  /** 该角色特有的参数（回答模型：-n 与 chat-template-kwargs；embedding/reranker：端点开关与池化） */
  extra: string[]
  /** 就绪后的预热请求（空 = 不预热） */
  warmup?: WarmupSpec
}

export interface ModelServiceOptions {
  paths: AppPaths
  runtime: RoleRuntime
  host: string
  portRetry: number
  onStatus: (s: ServiceStatus) => void
}

export class ModelService {
  private readonly paths: AppPaths
  private readonly rt: RoleRuntime
  private readonly host: string
  private readonly portRetry: number
  private readonly onStatus: (s: ServiceStatus) => void
  private child: ChildProcess | null = null
  private status: ServiceStatus
  private stopping = false

  constructor(options: ModelServiceOptions) {
    this.paths = options.paths
    this.rt = options.runtime
    this.host = options.host
    this.portRetry = options.portRetry
    this.onStatus = options.onStatus
    this.status = { role: this.rt.role, state: 'starting' }
  }

  getStatus(): ServiceStatus {
    return this.status
  }

  /** 当前 llama-server 的可执行文件路径（由协调者选定的后端决定：cpu / cuda 两个目录，D2-3） */
  private get serverExe(): string {
    return this.exeFor(this.ngl > 0 ? 'cuda' : 'cpu')
  }

  private exeFor(backend: Backend): string {
    return join(this.paths.llamacppDir, backend, 'llama-server.exe')
  }

  private setStatus(next: ServiceStatus): void {
    this.status = next
    try {
      this.onStatus(next)
    } catch (err) {
      console.warn('[process-manager] 状态回调失败：', (err as Error).message)
    }
  }

  /**
   * ⚠️ 与服务无关的缺陷：`ngl > 0` 就选 cuda 版 exe —— 由协调者保证「选了 cuda 就一定存在 cuda 版」；
   * 若不存在，startOnce 会以「缺少 llama-server.exe」明确指出（不静默降级）。
   */
  private get ngl(): number {
    return this.rt.ngl
  }

  /** 启动并等到就绪；成功后做一次预热调用（失败只记日志，不影响就绪） */
  async start(): Promise<ServiceStatus> {
    this.setStatus({ role: this.rt.role, state: 'starting', message: '正在加载模型…' })
    const exe = this.serverExe
    if (!existsSync(exe)) {
      const message = '缺少 llama-server.exe：\n' + exe + '\n  → 该服务被指定为 ' + (this.ngl > 0 ? 'cuda' : 'cpu') + ' 后端'
      this.setStatus({ role: this.rt.role, state: 'error', message })
      throw new Error(message)
    }
    if (!existsSync(this.rt.modelPath)) {
      const message = '缺少模型文件：\n' + this.rt.modelPath
      this.setStatus({ role: this.rt.role, state: 'error', message })
      throw new Error(message)
    }

    mkdirSync(this.paths.logsDir, { recursive: true })
    let lastError = ''
    for (let attempt = 1; attempt <= Math.max(1, this.portRetry); attempt++) {
      const port = await findFreePort(this.host)
      const logPath = join(
        this.paths.logsDir,
        'llama-server-' + this.rt.role + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.log',
      )
      const args = [
        '-m', this.rt.modelPath,
        '-c', String(this.rt.ctx),
        '-ngl', String(this.ngl),
        ...this.rt.extra,
        '--host', this.host,
        '--port', String(port),
        '--log-file', logPath,
      ]
      logEvent(this.paths, { event: 'model-service:spawn', role: this.rt.role, attempt, port, exe, model: this.rt.modelPath, logPath })
      const child = spawn(exe, args, { cwd: this.paths.llamacppDir, windowsHide: true, stdio: 'ignore' })
      this.child = child
      child.once('exit', (code, signal) => {
        logEvent(this.paths, { event: 'model-service:exit', role: this.rt.role, code, signal })
        if (!this.stopping && this.status.state === 'ready') {
          this.setStatus({
            role: this.rt.role,
            state: 'error',
            message: '模型服务意外退出（退出码 ' + code + '）\n日志：' + logPath,
            logPath,
          })
        }
      })
      const ready = await waitForReady(port, { shouldAbort: () => this.stopping })
      if (ready.ok) {
        const status: ServiceStatus = { role: this.rt.role, state: 'ready', port, logPath }
        this.setStatus(status)
        logEvent(this.paths, { event: 'model-service:ready', role: this.rt.role, port, loadMs: ready.elapsedMs, logPath })
        console.log('[process-manager] ' + this.rt.role + ' 就绪：端口 ' + port + '，加载 ' + ready.elapsedMs + ' ms')
        await this.warmup(port)
        return status
      }
      lastError = ready.reason === 'timeout'
        ? '模型加载超时（' + Math.round(ready.elapsedMs / 1000) + ' s）\n日志：' + logPath
        : '等待模型就绪被中止'
      logEvent(this.paths, { event: 'model-service:not-ready', role: this.rt.role, attempt, port, reason: ready.reason, lastError: ready.lastError, logPath })
      this.killChild()
    }
    this.setStatus({ role: this.rt.role, state: 'error', message: lastError || '模型服务启动失败' })
    throw new Error(this.status.message)
  }

  /** 预热：就绪后打一次真实请求（结果丢弃）。失败**只记日志**，不让服务变成不可用 */
  private async warmup(port: number): Promise<void> {
    const spec = this.rt.warmup
    if (!spec) return
    const started = Date.now()
    try {
      const res = await fetch('http://127.0.0.1:' + port + spec.path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spec.body),
        signal: AbortSignal.timeout(15000),
      })
      const elapsedMs = Date.now() - started
      if (!res.ok) {
        logEvent(this.paths, { event: 'model-service:warmup-failed', role: this.rt.role, status: res.status, elapsedMs })
        console.warn('[process-manager] ' + this.rt.role + ' 预热返回 HTTP ' + res.status)
        return
      }
      await res.arrayBuffer()
      logEvent(this.paths, { event: 'model-service:warmup', role: this.rt.role, elapsedMs })
      console.log('[process-manager] ' + this.rt.role + ' 预热完成 ' + elapsedMs + ' ms')
    } catch (err) {
      logEvent(this.paths, { event: 'model-service:warmup-failed', role: this.rt.role, message: (err as Error).message, elapsedMs: Date.now() - started })
      console.warn('[process-manager] ' + this.rt.role + ' 预热失败（不影响就绪）：' + (err as Error).message)
    }
  }

  private killChild(): void {
    const child = this.child
    if (!child || child.exitCode !== null) {
      this.child = null
      return
    }
    try {
      child.kill()
    } catch {
      /* 已退出 */
    }
    this.child = null
  }

  /** 停止本服务（不留孤儿） */
  stop(): void {
    this.stopping = true
    this.killChild()
  }
}

// ---------------------------------------------------------------------------
// 协调者：检测一次后端 → 依次起三个服务
// ---------------------------------------------------------------------------

export interface ModelServicesOptions {
  paths: AppPaths
  config: ModelsConfig
  /** 每个服务的状态变化（渲染进程只订阅 answer 的那一条，见 main.ts） */
  onStatus: (s: ServiceStatus) => void
  /** 「弹一次说明」的钩子（无 N 卡降级 / CUDA 起不来改 CPU）；由主进程负责弹框 */
  onNotice?: (text: string) => void
}

export interface StartAllResult {
  answer: ServiceStatus
  /** 辅助服务的结果（未启用的不含在内） */
  aux: ServiceStatus[]
  /** 辅助服务的失败（**不阻塞对话**，但必须指名报错） */
  failures: Array<{ role: ServiceRole; message: string }>
}

export class ModelServices {
  private readonly paths: AppPaths
  private readonly config: ModelsConfig
  private readonly onStatus: (s: ServiceStatus) => void
  private readonly onNotice: (text: string) => void
  /** 本次启动选定的后端（由检测结果填） */
  private backend: Backend = 'cpu'
  /** 🆕 v0.3.2：运行档位（= 强制开关 ⊕ 检测结果） */
  private dial: Dial = 'cpu'
  /** 🆕 v0.3.2：CPU 档的线程计划；**GPU 档为 null = 一个线程参数都不注入** */
  private threadPlan: ThreadPlan | null = null
  /** 🆕 v0.3.2：本机逻辑核数（只用来算线程，不做物理核探测） */
  private logicalCores = 1
  private answer: ModelService | null = null
  private readonly aux: ModelService[] = []

  constructor(options: ModelServicesOptions) {
    this.paths = options.paths
    this.config = options.config
    this.onStatus = options.onStatus
    this.onNotice = options.onNotice ?? ((): void => undefined)
  }

  // -------------------------------------------------------------------------
  // 🆕 v0.3.2：分档（档位裁决 + 按档取配置）
  //   🔴 必须在 `this.backend` 定下来之后、建 RoleRuntime **之前**调用 resolveDial()。
  // -------------------------------------------------------------------------

  /** 算档位 + CPU 档线程计划（幂等：后端变化后要重新调用） */
  private resolveDial(): void {
    this.logicalCores = safeLogicalCores()
    this.dial = pickDial(this.config.answer.backend, this.backend)
    // 🔴 兜底（2026-10-22 实测踩到）：强制写 cuda、但这台机器上 cuda 版 llama-server 不存在时，
    //    档位如果仍留在 cuda，就会去 spawn 一个不存在的 exe —— 整个回答服务直接报错、程序不可用。
    //    交付包必须「任何配置都能开」，所以这里落回 cpu（CPU 版运行库与 Q4 模型是必带的）。
    if (this.dial === 'cuda') {
      const cudaExe = join(this.paths.llamacppDir, 'cuda', 'llama-server.exe')
      if (!existsSync(cudaExe)) {
        const forced = this.config.answer.backend
        this.dial = 'cpu'
        logEvent(this.paths, {
          event: 'dial:fallback',
          from: 'cuda',
          to: 'cpu',
          forced: forced ?? 'auto',
          reason: '缺 cuda 版 llama-server：' + cudaExe,
        })
        console.warn('[process-manager] 强制=' + forced + '，但缺 ' + cudaExe + ' → 落回 CPU 档（功能不变，速度慢些）')
      }
    }
    this.threadPlan =
      this.dial === 'cpu'
        ? resolveThreads(this.logicalCores, {
            threads: this.config.answer.threads,
            threadsBatch: this.config.answer.threadsBatch,
            singleSlot: this.config.answer.singleSlot,
          })
        : null
  }

  private cpuBlock(): Record<string, unknown> | undefined {
    return this.config.cpu
  }

  /** 按档合并后的回答模型配置（`cuda` 档 = 顶层原值，一字不动） */
  private answerCfg(): AnswerConfig {
    return dialConfig(this.config.answer, this.cpuBlock()?.answer, this.dial)
  }

  /** 按档合并后的辅助服务配置（embedding 不受分档影响；reranker 受 —— CPU 档不启动） */
  private auxCfg(role: 'embedding' | 'reranker'): AuxConfig {
    return dialConfig(this.config[role], this.cpuBlock()?.[role], this.dial)
  }

  /** 回答模型的完整路径（**模型子目录也可被 cpu 块覆盖** → Q4 在 `answer-q4km/`） */
  private answerModelPath(): string {
    const c = this.answerCfg()
    const dir = c.modelDir && c.modelDir.length > 0 ? c.modelDir : 'answer'
    return join(this.paths.modelsDir, dir, c.gguf)
  }

  /**
   * 🔴 回答模型的 `-ngl` —— **由档位决定，不看检测结果**。
   *
   * 为什么单独抽出来（2026-10-12 首轮 CPU 实测踩到的真 bug）：
   *   只把 `dial` 设成 cpu、却仍用 `nglFor(this.backend)` 取 ngl，会出现
   *   **「档位=cpu、实际 `-ngl 99` + CUDA 版 exe 在 GPU 上跑」**的**静默半档**：
   *   日志、档案、界面全说自己是 CPU 档，速度却是 GPU 的（首字 0.9 s，CPU 不可能）。
   *   `ModelService` 又是按 `ngl > 0` 选 exe 的（`:353`），所以 ngl 必须与档位一致。
   *
   * 辅助服务（embedding / reranker）**不跟档位**，仍按 `nglFor(this.backend)` —— 它们各自有
   * `backend` 字段可单独锁定（D25-07），CPU 档下把 embedding 留 GPU 是合理的（它很便宜）。
   */
  private answerNgl(): number {
    return this.dial === 'cpu' ? this.config.answer.ngl : this.config.answer.nglGpu
  }

  /**
   * 回答模型的启动参数（`extra`）。🔴 **CPU 档才注入线程**；GPU 档保持与 v0.3.1 逐字等价。
   * 🔴 本文件里 `extra` 有**两处**（`startAll` 与 `restartAnswer`）—— 两处都必须走这个 helper。
   */
  private answerExtra(): string[] {
    const c = this.answerCfg()
    const out = [
      '-n', String(c.n),
      '--chat-template-kwargs', JSON.stringify({ enable_thinking: c.enableThinking }),
    ]
    if (this.threadPlan) out.push(...threadArgs(this.threadPlan))
    return out
  }

  /** 给主进程 / 档案 / 验收用的档位快照 */
  dialSnapshot(): DialSnapshot {
    return {
      dial: this.dial,
      backend: this.backend,
      forced: this.config.answer.backend ?? 'auto',
      logicalCores: this.logicalCores,
      threads: this.threadPlan ? describeThreads(this.threadPlan, this.logicalCores) : null,
      threadNums: this.threadPlan
        ? { t: this.threadPlan.t, tb: this.threadPlan.tb, singleSlot: this.threadPlan.singleSlot }
        : null,
      model: this.answerModelPath(),
      ngl: this.answerNgl(),
      rerankerEnabled: this.auxCfg('reranker').enabled,
    }
  }

  /** 启动前精确清理上次残留：**只杀命令行里含我们 models 目录的** llama-server（三个角色一起） */
  killStrays(): number {
    const target = this.paths.modelsDir.toLowerCase()
    const mine = listLlamaProcesses().filter((p) => p.commandLine.toLowerCase().includes(target))
    for (const p of mine) {
      try {
        process.kill(p.pid)
        logEvent(this.paths, { event: 'model-service:kill-stray', pid: p.pid })
      } catch (err) {
        console.warn('[process-manager] 清理残留失败 pid=' + p.pid + '：', (err as Error).message)
      }
    }
    return mine.length
  }

  /** 先按缓存起步、探测在后台跑（目标 2 §4.4 实测口径）；随后依次起三个服务 */
  async startAll(): Promise<StartAllResult> {
    const cache = readHardwareCache(this.paths)
    const cacheUsable = cache !== null && existsSync(join(this.paths.llamacppDir, cache.backend, 'llama-server.exe'))
    const probePromise = detectBackend(this.paths, this.config)
    if (cacheUsable && cache) {
      this.backend = cache.backend
      logEvent(this.paths, { event: 'gpu:cache-hit', backend: cache.backend, ngl: this.nglFor(cache.backend) })
      console.log('[process-manager] 用缓存后端起步：' + cache.backend + '（探测在后台跑）')
      void probePromise.then((p) => this.applyProbe(p, cache)).catch(() => undefined)
    } else {
      const probe = await probePromise
      this.backend = probe.backend
      this.applyProbe(probe, cache)
    }

    // 🆕 v0.3.2：档位裁决 + CPU 档线程计划（**必须在建 RoleRuntime 之前**）
    this.resolveDial()
    const snap0 = this.dialSnapshot()
    logEvent(this.paths, { event: 'dial:resolved', ...snap0, where: 'startAll' })
    console.log(
      '[process-manager] 档位=' + snap0.dial +
      '（强制=' + snap0.forced + '，检测=' + snap0.backend + '）' +
      '｜' + (snap0.threads ?? '不注入线程参数（GPU 档保持与 v0.3.1 逐字等价）') +
      '｜回答模型=' + snap0.model +
      '｜-ngl=' + snap0.ngl + '（exe=' + (snap0.ngl > 0 ? 'cuda' : 'cpu') + '）' +
      '｜reranker=' + (snap0.rerankerEnabled ? '启用' : '不启用'),
    )

    const strays = this.killStrays()
    if (strays > 0) console.log('[process-manager] 清理残留 llama-server：' + strays + ' 个')

    // ① 回答模型：失败即抛（主进程弹框 + 状态条，逻辑同目标 2）
    const answerRuntime: RoleRuntime = {
      role: 'answer',
      modelPath: this.answerModelPath(),
      ctx: this.answerCfg().ctx,
      // 🔴 必须用 answerNgl()（档位决定），不能用 nglFor(this.backend)（检测决定）——
      //    后者会让「强制 CPU 档」变成静默半档：档位说 cpu、实际 -ngl 99 跑在 GPU 上
      ngl: this.answerNgl(),
      extra: this.answerExtra(),
    }
    this.answer = new ModelService({
      paths: this.paths,
      runtime: answerRuntime,
      host: this.config.server.host,
      portRetry: this.config.server.portRetry ?? 3,
      onStatus: this.onStatus,
    })
    let answerStatus: ServiceStatus
    try {
      answerStatus = await this.answer.start()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (this.backend !== 'cuda') throw err
      // 🔴 强制 `answer.backend='cuda'` 时**不做 CPU 回退**：用户明确要 cuda，
      //    静默换成 CPU 既违「不得静默降级」，也会让人误以为「这台机器 cuda 可用」。
      if (this.config.answer.backend === 'cuda') throw err
      // CUDA 起不来 → 重测一次；设备确实没了才改 CPU 重试并**明确告知**（不静默降级）
      const again = await detectBackend(this.paths, this.config)
      logEvent(this.paths, { event: 'gpu:reprobe-after-failure', backend: again.backend, reason: again.reason, firstError: message })
      if (again.backend !== 'cpu') throw err
      this.backend = 'cpu'
      writeHardwareCache(this.paths, { backend: 'cpu', ngl: again.ngl, detectedAt: Date.now(), warnedBackend: 'cpu', deviceLines: again.deviceLines })
      this.onNotice('CUDA 后端启动失败，已改用 CPU 重试。\n\n失败原因：' + message + '\n\n（重测结果：' + again.reason + '）')
      // 🆕 v0.3.2：后端变了 → **档位可能跟着变**（auto 开关下 cuda→cpu）。
      //   必须重算档位与线程计划，否则会拿 GPU 档的模型路径/参数去起 CPU 服务
      //   （表现为：CPU 上还在加载 Q8、还不注入线程 —— 静默「半档」，最难查）。
      this.resolveDial()
      answerRuntime.ngl = this.answerNgl()
      answerRuntime.modelPath = this.answerModelPath()
      answerRuntime.ctx = this.answerCfg().ctx
      answerRuntime.extra = this.answerExtra()
      const snapFallback = this.dialSnapshot()
      logEvent(this.paths, { event: 'dial:resolved', ...snapFallback, where: 'startAll-cuda回退后' })
      console.log('[process-manager] 回退后重算档位=' + snapFallback.dial + '｜' + (snapFallback.threads ?? '不注入线程参数') + '｜回答模型=' + snapFallback.model)
      this.answer = new ModelService({
        paths: this.paths,
        runtime: answerRuntime,
        host: this.config.server.host,
        portRetry: this.config.server.portRetry ?? 3,
        onStatus: this.onStatus,
      })
      answerStatus = await this.answer.start()
    }

    // ② 辅助服务：一个一个起；失败**收集起来**（不阻塞对话），但要指名报错
    const aux: ServiceStatus[] = []
    const failures: Array<{ role: ServiceRole; message: string }> = []
    const plan: Array<{ role: 'embedding' | 'reranker'; cfg: AuxConfig }> = [
      { role: 'embedding', cfg: this.auxCfg('embedding') },
      // 🆕 v0.3.2：reranker **受分档控制** —— CPU 档根本不启动它（省约 600 MB，12- RR-B1）
      { role: 'reranker', cfg: this.auxCfg('reranker') },
    ]
    for (const item of plan) {
      if (!item.cfg.enabled) {
        const s: ServiceStatus = {
          role: item.role,
          state: 'error',
          enabled: false,
          message:
            item.role === 'reranker' && this.dial === 'cpu'
              ? '未启用（CPU 档：config/models 的 `cpu.reranker.enabled=false` —— 满足 RR-B1「能力保留 ≠ 常驻加载」）'
              : '未启用（config/models 里 enabled=false）',
        }
        this.onStatus(s)
        aux.push(s)
        logEvent(this.paths, { event: 'model-service:disabled', role: item.role })
        continue
      }
      const backend = item.cfg.backend === 'auto' ? this.backend : item.cfg.backend
      const modelPath = join(this.paths.modelsDir, item.role, item.cfg.gguf)
      const extra = item.role === 'embedding'
        ? ['--embedding', '--pooling', item.cfg.pooling, '--embd-normalize', String(item.cfg.embdNormalize ?? 2)]
        : [
            '--reranking', '--pooling', item.cfg.pooling,
            // 物理批必须 ≥ 最长「问题+段落」（D25-20 实测：默认 512 不够真实段落）
            '-b', String(item.cfg.batchSize ?? 2048),
            '-ub', String(item.cfg.ubatchSize ?? 2048),
          ]
      const warmText = item.cfg.warmup && item.cfg.warmup.length > 0 ? item.cfg.warmup : undefined
      const runtime: RoleRuntime = {
        role: item.role,
        modelPath,
        ctx: item.cfg.ctx,
        ngl: this.nglFor(backend),
        extra,
        warmup: warmText
          ? item.role === 'embedding'
            ? { path: '/v1/embeddings', body: { input: warmText } }
            : { path: '/v1/rerank', body: { query: warmText, documents: [warmText] } }
          : undefined,
      }
      const svc = new ModelService({
        paths: this.paths,
        runtime,
        host: this.config.server.host,
        portRetry: this.config.server.portRetry ?? 3,
        onStatus: this.onStatus,
      })
      this.aux.push(svc)
      try {
        aux.push(await svc.start())
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        failures.push({ role: item.role, message })
        aux.push({ role: item.role, state: 'error', message })
        logEvent(this.paths, { event: 'model-service:failed', role: item.role, message })
        console.error('[process-manager] ' + item.role + ' 启动失败：' + message)
      }
    }

    logEvent(this.paths, {
      event: 'services:start-all',
      backend: this.backend,
      dial: this.dial,
      threads: this.threadPlan ? describeThreads(this.threadPlan, this.logicalCores) : null,
      answerModel: this.answerModelPath(),
      answer: { state: answerStatus.state, port: answerStatus.port },
      aux: aux.map((s) => ({ role: s.role, state: s.state, port: s.port, enabled: s.enabled })),
      failures: failures.map((f) => f.role + ': ' + f.message),
    })
    return { answer: answerStatus, aux, failures }
  }

  /** 只重启回答模型（`service:restart` 的语义不变） */
  async restartAnswer(): Promise<ServiceStatus> {
    this.answer?.stop()
    // 🆕 v0.3.2：🔴 这里**必须**走与 startAll 完全相同的 helper ——
    //   `extra` 在本文件里有**两处**，这是第二处。漏改的后果是：
    //   「用户点一次『重启模型』→ 线程参数与 Q4 模型路径就悄悄丢了」。
    //   同时重新裁决档位（后端可能在这期间变过，例如插上了显卡）。
    this.resolveDial()
    const snapRestart = this.dialSnapshot()
    logEvent(this.paths, { event: 'dial:restart-answer', ...snapRestart })
    console.log('[process-manager] 重启回答模型：档位=' + snapRestart.dial + '｜' + (snapRestart.threads ?? '不注入线程参数') + '｜模型=' + snapRestart.model)
    const runtime: RoleRuntime = {
      role: 'answer',
      modelPath: this.answerModelPath(),
      ctx: this.answerCfg().ctx,
      ngl: this.answerNgl(),
      extra: this.answerExtra(),
    }
    this.answer = new ModelService({
      paths: this.paths,
      runtime,
      host: this.config.server.host,
      portRetry: this.config.server.portRetry ?? 3,
      onStatus: this.onStatus,
    })
    return this.answer.start()
  }

  /** 三个服务的当前状态（给后端与日志用） */
  statuses(): ServiceStatus[] {
    const list: ServiceStatus[] = []
    if (this.answer) list.push(this.answer.getStatus())
    for (const s of this.aux) list.push(s.getStatus())
    return list
  }

  /** 关窗/退出时调用：终止全部子进程，**不留孤儿** */
  stopAll(): void {
    this.answer?.stop()
    for (const s of this.aux) s.stop()
    const left = this.killStrays()
    logEvent(this.paths, { event: 'model-service:stop', killedExtra: left })
  }

  private nglFor(backend: Backend): number {
    return backend === 'cuda' ? this.config.answer.nglGpu : this.config.answer.ngl
  }

  /** 探测结果的落点：写日志 + 写缓存 + 按 D2-21 决定是否弹说明 */
  private applyProbe(probe: GpuProbeResult, cache: HardwareCache | null): void {
    const changed = cache !== null && cache.backend !== probe.backend
    console.log(
      '[process-manager] 后端探测：' + probe.backend + ' ngl=' + probe.ngl + '（' + probe.reason + '；' + probe.elapsedMs + ' ms）' +
        (changed ? '  ⚠️ 与缓存（' + (cache ? cache.backend : '-') + '）不同，下次启动生效' : ''),
    )
    logEvent(this.paths, { event: 'gpu:probe', backend: probe.backend, ngl: probe.ngl, elapsedMs: probe.elapsedMs, reason: probe.reason, devices: probe.deviceLines, changed })
    if (probe.backend === 'cpu' && this.backend === 'cpu' && cache?.warnedBackend !== 'cpu') {
      logEvent(this.paths, { event: 'gpu:notice-shown', backend: probe.backend })
      this.onNotice(readNoGpuNotice(this.paths))
    }
    writeHardwareCache(this.paths, {
      backend: probe.backend,
      ngl: probe.ngl,
      detectedAt: Date.now(),
      warnedBackend: probe.backend,
      deviceLines: probe.deviceLines,
    })
  }
}
