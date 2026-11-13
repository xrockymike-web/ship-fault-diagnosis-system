import { app, BrowserWindow, dialog, ipcMain, shell, utilityProcess, MessageChannelMain, type UtilityProcess } from 'electron'
// 🆕 v0.3.2：档位（下发给渲染进程：按档超时值 + 界面提示语）
import { timeoutForDial, DIAL_NOTICE } from '../../shared/dial'
import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
// 下面几条 import 在源码侧是相对路径，构建时被标为 external 并把路径改写成产物侧布局
// （见 vite.config.ts 的 BACKEND_EXTERNALS / backendPaths）：
//   ../../launcher/bootstrap/index       → require('./launcher/bootstrap/index.js')
//   ../../launcher/process-manager/index → require('./launcher/process-manager/index.js')
//   ../../qa-core/index                  → require('./qa-core/index.js')
// 目的：后端模块必须从磁盘加载、不能内联 —— 否则 bootstrap 会同时存在两份实例。
import { LayoutError, describePaths, ensureRuntimeDirs, resolvePaths, selfCheck, type AppPaths } from '../../launcher/bootstrap/index'
import { ModelServices, loadModelsConfig, type AnswerConfig, type ServiceStatus } from '../../launcher/process-manager/index'
import { guardStdio, logEvent, stdioErrorCount, writeStartupRecord } from '../../launcher/diagnostics/index'
import { bootstrapQaCore } from '../../qa-core/index'

/**
 * 🔴 **最早的一行**：给 stdout/stderr 挂 EPIPE 兜底（2026-10-06 实测修）。
 * 背景：stdout 是「会被关掉的管道」时（脚本化启动 / 后台任务被回收 / 父控制台关闭），
 * 任意一句 `console.log` 会抛 `EPIPE: broken pipe, write` → 主进程未捕获异常 →
 * Electron 弹「A JavaScript error occurred in the main process」，用户看到的是"程序崩了"。
 * 放在这里是因为：**必须在任何一句 console.log 之前生效**（本文件下面就有）。
 */
guardStdio()

/** 三段冷启动计时的 t0：本文件顶部是"最早可观测点"（施工单 §18.5） */
const T0 = Date.now()
let t1: number | undefined
let t2: number | undefined

/**
 * 落盘 startup.json —— **t1 与 t2 各自到达时就写**。
 *
 * 2026-09-27 实测教训：原先只在 t2 时写一次，而 Electron 的 `ready-to-show`
 * **在 show:true 的窗口上不保证触发**（官方注释：该事件应配合 show:false 使用），
 * 于是 startup.json 里偶尔缺 t1。现在改为窗口就绪即 show + 两次落盘。
 */
/**
 * 把被吞掉的 stdio 流错误计数写进 app.log（**不静默**；计数为 0 不写噪音）。
 * ⚠️ 2026-10-06 踩到：EPIPE **不是**在启动那一刻发生的（它发生在**模型预热**或**退出清理**时），
 * 所以只在启动写一次等于没写 → 现在**三处**都记：启动自检 / 服务起完 / 退出前。
 */
function logStdioIfAny(): void {
  const p = paths
  if (!p) return
  const stdio = stdioErrorCount()
  if (stdio.count > 0) logEvent(p, { event: 'stdio:epipe', count: stdio.count, last: stdio.last })
}

function flushStartup(mode: string): void {
  const now = Date.now()
  writeStartupRecord(paths!, {
    t0: T0,
    t1,
    t2,
    totalMs: (t2 ?? now) - T0,
    mode,
  })
}

/**
 * 🔴 **必须在任何窗口/会话创建之前**把 Electron 的 userData 从 %APPDATA% 挪进 data/runtime/。
 *
 * 实测（2026-09-27，阶段 1.6）：不设这一行，程序会在 %APPDATA%\ship-diagnosis\
 * 留下 17.5 MB 的 Cache / GPUCache / **Local Storage** ——
 * ① 违反 §2.7「写入集中在 data/runtime/」；② 会话存在 Local Storage 里，
 * 而它在系统盘 → "把文件夹搬到另一台电脑会话不丢"（§2.4.5）不成立。
 *
 * 放在模块顶层（而不是 app.whenReady 里）是为了抢在 Chromium 初始化 profile 之前。
 */
let paths: AppPaths | undefined
/** 顶层解析失败的原因；whenReady 里弹框并退出（那时才能弹） */
let layoutError: string | null = null
try {
  paths = resolvePaths()
  mkdirSync(paths.chromiumDir, { recursive: true })
  app.setPath('userData', paths.chromiumDir)
  app.setPath('sessionData', paths.chromiumDir)
} catch (err) {
  layoutError = err instanceof LayoutError ? err.message : String(err)
}

/**
 * 目标 2.5 步骤 2.5.0：**单实例锁**（结掉目标 2 施工单 §9 问题 32 的遗留观察项）。
 *
 * 为什么需要：多实例并发时，第二个实例拿不到 `data/runtime/chromium` 的 profile 锁，
 * Chromium 会**回落到默认路径** `%APPDATA%/ship-diagnosis`，把 GPU 着色器缓存写到系统盘 ——
 * 既违反「只有 data/runtime 可写」，也让「连文件夹搬走」不成立（曾实测出现过一次，删后不再复现）。
 *
 * 位置：模块顶层、**任何窗口/会话创建之前**（越早越好；拿不到锁的进程在建 Chromium profile 之前就退出，
 * 所以不会产生任何回落写入）。
 */
const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) {
  // 已有实例在跑：本进程立刻退出（不建窗口、不起模型服务、不写任何文件）
  console.log('[ship-app] 已有实例在运行，本进程退出（单实例锁）')
  app.quit()
} else {
  // 第二个实例被拒之后，把已有窗口唤到前台（用户双击两次时的直觉行为）
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
}

let services: ModelServices | null = null
/** 目标 2.1：后端 utilityProcess（D2-10）；未起来时为 null */
let backend: UtilityProcess | null = null
/** 目标 2.2：下发给后端的回答模型参数（主进程是 config/models 的唯一读者，R3） */
let answerConfig: AnswerConfig | null = null
/** 服务状态；窗口出现后由 IPC 推送给渲染进程（施工单 §16.6 方案甲） */
let lastStatus: ServiceStatus = { role: 'answer', state: 'starting', message: '正在启动…' }

/**
 * 目标 2.5：**渲染进程的画面只由回答模型驱动**（状态条语义不变），
 * 三个服务的状态一起下发给后端（端口要给它用），不改变界面。
 */
function broadcastStatus(status: ServiceStatus): void {
  if (status.role === 'answer') {
    lastStatus = status
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('service:status', status)
    }
  }
  pushServicesToBackend()
}

/** 目标 2.5：把三个服务的状态（含各自端口）同步给后端 —— 后端要用 embedding / reranker 的端口 */
function pushServicesToBackend(): void {
  backend?.postMessage({
    kind: 'service',
    status: lastStatus,
    services: services?.statuses() ?? [],
    answer: answerConfig ?? undefined,
    // 🆕 v0.3.2：档位快照（后端据此按档取配置 + 把档位/线程写进档案）
    dial: services?.dialSnapshot(),
  })
}

/**
 * 目标 2.2：把后端端口转交给渲染进程 —— 之后 token 走 MessagePort **直连**，主进程不在数据通路上。
 * 每个窗口一份新的 MessageChannel（窗口重载/多窗口都安全；旧端口随旧渲染进程消失）。
 */
function connectRenderer(win: BrowserWindow, p: AppPaths): void {
  if (!backend) return
  const channel = new MessageChannelMain()
  backend.postMessage({ kind: 'port' }, [channel.port1])
  win.webContents.postMessage('backend:port', null, [channel.port2])
  logEvent(p, { event: 'backend:renderer-port', window: win.id })
}

function createWindow(p: AppPaths): void {
  const win = new BrowserWindow({
    title: '船舶故障诊断系统',
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#f7f7f8',
    show: false, // 先不显示：等 ready-to-show 再 show，避免白屏闪烁，同时让 t1 有意义
    icon: join(p.programRoot, 'frontend', 'assets', 'anchor.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // t1 = 窗口出现（§18.5）。show:false + 就绪即 show 是 Electron 的标准做法。
  const markShown = () => {
    if (t1 === undefined) {
      t1 = Date.now()
      if (paths) flushStartup(paths.mode)
    }
    if (!win.isVisible()) win.show()
  }
  win.once('ready-to-show', markShown)
  // 兜底：个别环境 ready-to-show 仍可能不触发 —— 页面加载完也一定要把窗口显示出来
  win.webContents.once('did-finish-load', markShown)

  // 窗口一出现就把当前状态 + 后端端口交给渲染进程（避免"错过"第一次推送）。
  // 用 on 而不是 once：dev 态渲染进程热重载后要重新接端口。
  win.webContents.on('did-finish-load', () => {
    if (win.isDestroyed()) return
    win.webContents.send('service:status', lastStatus)
    connectRenderer(win, p)
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    void win.loadFile(p.frontendIndex)
  }
}

/**
 * 拉起模型服务；失败**弹系统对话框**并同时把错误推给窗口（施工单 §16.5 致命级）。
 * `alreadyReported` = 启动自检已经弹过一次框，这里就不再弹第二个（避免连环对话框）。
 */
async function startModelService(p: AppPaths, alreadyReported: boolean): Promise<void> {
  try {
    const config = loadModelsConfig(p)
    answerConfig = config.answer // 目标 2.2：随服务状态一起下发给后端
    services = new ModelServices({
      paths: p,
      config,
      onStatus: broadcastStatus,
      // 目标 2.6：无 N 卡（或 CUDA 起不来改 CPU）时**弹一次**说明 —— 文案来自 launcher/resources/
      onNotice: (text) => {
        console.log('[ship-app] 弹降级说明（' + text.split('\n')[0] + '…）')
        void dialog.showMessageBox({
          type: 'info',
          title: '船舶故障诊断系统 — 运行模式说明',
          message: '未使用显卡加速（CPU 模式）',
          detail: text,
          buttons: ['知道了'],
          noLink: true,
        })
      },
    })
    const started = await services.startAll()
    // t2 = 三服务就绪（回答模型就绪即算）；**正式冷启动口径 = t2 − t0**（§18.5）
    t2 = Date.now()
    flushStartup(p.mode)
    logStdioIfAny() // 预热阶段（最容易 EPIPE 的窗口）结束后记一次
    console.log(
      '[ship-app] 冷启动 t0→t1=' + (t1 ? t1 - T0 : -1) + 'ms  t1→t2=' + (t1 ? t2 - t1 : -1) + 'ms  **t0→t2=' + (t2 - T0) + 'ms**',
    )
    // 目标 2.5：辅助服务失败**不阻塞对话**，但必须指名道姓（红线「不得静默降级」）
    if (started.failures.length > 0) {
      const text = started.failures.map((f) => f.role + '：' + f.message).join('\n\n')
      console.error('[ship-app] 辅助服务启动失败：\n' + text)
      if (!alreadyReported) {
        dialog.showErrorBox(
          '船舶故障诊断系统 — 辅助服务启动失败',
          text + '\n\n回答功能不受影响；按上面的路径修好文件（或改 config/models 的 enabled）后重启程序即可。',
        )
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[ship-app] 模型服务启动失败：' + message)
    broadcastStatus({ role: 'answer', state: 'error', message })
    if (!alreadyReported) dialog.showErrorBox('船舶故障诊断系统 — 模型服务启动失败', message)
  }
}

/**
 * 后端进程（目标 2.1 / D2-10）。
 *
 * 🔴 `utilityProcess` 是**纯 Node 环境、没有 Electron API**，所以：
 *    · AppPaths 由主进程算好后经 argv 注入（worker 不解析路径、也不 require bootstrap）；
 *    · 通信走 worker 侧 `process.parentPort` / 主进程侧 `child.postMessage`。
 * 实测证据：交接文档/验收记录/目标2/02-utilityprocess.md。
 */
function startBackend(p: AppPaths): void {
  const entry = join(p.programRoot, 'qa-core', 'index.js')
  if (!existsSync(entry)) {
    const message = '后端入口不存在：' + entry + '\n  → 请先跑 npm run build（三段构建的产物）'
    console.error('[ship-app] ' + message)
    logEvent(p, { event: 'backend:missing', entry })
    dialog.showErrorBox('船舶故障诊断系统 — 后端缺失', message)
    return
  }

  backend = utilityProcess.fork(entry, [JSON.stringify(p)], {
    serviceName: 'ship-diagnosis-backend',
    stdio: 'inherit', // worker 的 console 直接进父进程 stdout（命令行取证用）
  })

  backend.on('message', (msg: any) => {
    console.log('[backend] ← ' + JSON.stringify(msg))
    logEvent(p, { event: 'backend:message', msg })
    const kind = (msg as { kind?: string } | null)?.kind
    if (kind === 'hello') backend?.postMessage({ kind: 'ping', id: 1 })
    if (kind === 'pong') console.log('[backend] MessagePort 双向通 ✅ (id=' + (msg as { id?: number }).id + ')')
  })
  backend.on('exit', (code: number) => {
    console.log('[ship-app] 后端进程退出 code=' + code)
    logEvent(p, { event: 'backend:exit', code })
    backend = null
  })
  backend.on('error', (type: string, location: string) => {
    console.error('[ship-app] 后端进程致命错误 ' + type + ' @ ' + location)
    logEvent(p, { event: 'backend:fatal', type, location })
  })

  console.log('[ship-app] 后端已 fork → ' + entry)
  logEvent(p, { event: 'backend:fork', entry })
  // pid 要等 'spawn' 才有（fork() 返回时还是 undefined —— 目标 2.1 实测）
  backend.on('spawn', () => {
    console.log('[ship-app] 后端进程已起来 pid=' + backend?.pid)
    logEvent(p, { event: 'backend:spawn', pid: backend?.pid })
  })
}

app.whenReady().then(() => {
  // 目标 2.5：拿不到单实例锁的进程直接返回（app.quit() 是异步的，这里再加一道保险）
  if (!singleInstance) return
  // 启动第一步：路径解析已在模块顶层完成（为了抢在 Chromium 建 profile 之前）。
  // 失败必须弹框说明缺什么再退出 —— 不静默降级（红线）。
  if (!paths) {
    dialog.showErrorBox('船舶故障诊断系统 — 启动失败', '布局解析失败：\n\n' + (layoutError ?? '未知错误'))
    app.exit(1)
    return
  }
  const p = paths // 收窄为 AppPaths，供下面的闭包使用
  ensureRuntimeDirs(p)
  const qa = bootstrapQaCore(p) // D2-10：AppPaths 由主进程注入，qa-core 不再自行解析路径
  console.log('[ship-app] ' + describePaths(p) + ' | ' + qa.describe)

  // 启动自检（§18.4）：逐项查，缺任何一项都**一次列全**并弹框，不静默
  const problems = selfCheck(p)
  logEvent(p, { event: 'startup:self-check', mode: p.mode, problems })
  logStdioIfAny()
  if (problems.length > 0) {
    dialog.showErrorBox(
      '船舶故障诊断系统 — 启动自检未通过',
      problems.map((p, i) => i + 1 + '. ' + p).join('\n\n'),
    )
  }

  ipcMain.handle('service:getStatus', () => lastStatus)
  // 🆕 v0.3.2：档位 + 按档超时 + 界面提示语。
  //   🔴 **只读**：渲染进程拿不到任何切换档位的入口（负责人 2026-10-12 定）。
  ipcMain.handle('dial:get', () => {
    const snap = services?.dialSnapshot() ?? null
    const dial = snap ? snap.dial : 'cuda'
    const t = timeoutForDial(dial)
    return { dial, snapshot: snap, firstTokenMs: t.firstTokenMs, totalMs: t.totalMs, notice: DIAL_NOTICE }
  })
  // 目标 2.2 起渲染进程**不再需要**模型参数与提示词：payload 由后端构造（D2-13），
  // 所以原来的 config:get IPC 已删除（不留死代码）。
  ipcMain.handle('service:restart', async () => {
    // 目标 2.5：只重启回答模型（辅助服务不受影响）
    if (!services) {
      await startModelService(p, true)
      return lastStatus
    }
    try {
      await services.restartAnswer()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      broadcastStatus({ role: 'answer', state: 'error', message })
    }
    return lastStatus
  })

  startBackend(p) // 目标 2.1：后端跑在 utilityProcess，渲染进程不再直连模型服务
  createWindow(p)
  // 启动即拉起模型服务（负责人确认，施工单 §16.2）：窗口先出现并显示「正在加载模型…」
  void startModelService(p, problems.length > 0)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(p)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 退出清理：关窗即终止子进程，不留孤儿（施工单 §16.1 第 6 条 / §16.3）
app.on('before-quit', () => {
  logStdioIfAny() // 退出阶段（句柄陆续消失）是最容易出 EPIPE 的窗口之一
  services?.stopAll()
  // 目标 2.1：后端进程必须一起收走，不留孤儿（验收第 ④ 项）
  if (backend) {
    backend.kill()
    backend = null
  }
})
