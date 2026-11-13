/**
 * 🔴 全项目唯一允许做路径解析的地方（红线：《技术路线总纲》§7.3、query/README §四）。
 * 其余模块一律通过注入的 AppPaths 取路径，不得自行拼接。
 *
 * 双形态探测（施工单 §6.2）：
 *   交付态 portable/query → <交付根>/{data,environment} 都存在
 *   开发态 query/bin    → 向上找到同时含 workspace/ 与 portable/ 的项目根
 * 两形态都不匹配 → 抛 LayoutError 并说明缺哪个目录（**不静默降级**）。
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type LayoutMode = 'development' | 'portable'

export interface AppPaths {
  mode: LayoutMode
  /** app.getAppPath() —— Electron 认为的 app 目录（交付态 = <交付根>/query/bin/resources/app） */
  appRoot: string
  /**
   * **程序根**：main.js / config / frontend / qa-core / launcher 所在的那一层。
   * 交付态 = `<交付根>/query`（**与 workspace/query 同名同构**，D2-28/D2-29）；开发态 = appRoot。
   */
  programRoot: string
  /**
   * **Electron 运行时根**：exe + *.dll/*.pak + locales/ + resources/app（跳板）所在的那一层。
   * 交付态 = `<交付根>/query/bin`；开发态 = `query/bin`。
   */
  runtimeRoot: string
  /** runtimeRoot 的旧名（保留以免破坏既有引用），值等同 runtimeRoot */
  binRoot: string
  /** programRoot/config */
  configDir: string
  /** programRoot/frontend/index.html */
  frontendIndex: string
  /** 交付态 <交付根>/data；开发态 <项目根>/workspace/data */
  dataDir: string
  /** 交付态 <交付根>/environment；开发态 <项目根>/workspace/environment */
  environmentDir: string
  /** 唯一可写目录：<dataDir>/runtime */
  runtimeDir: string
  /** runtimeDir/logs */
  logsDir: string
  /** <environmentDir>/llamacpp（其下按版本分 cpu / cuda） */
  llamacppDir: string
  /** <environmentDir>/models（其下分 answer / embedding / reranker） */
  modelsDir: string
  /**
   * Chromium/Electron 的 userData 目录 —— **必须**指向这里，不能让它落在 %APPDATA%。
   * 默认值会把 Cache / GPUCache / **Local Storage** 写到系统盘（实测 17.5 MB），
   * 既违反"写入集中在 data/runtime/"，也让"连文件夹一起搬走会话不丢"不成立。
   */
  chromiumDir: string
}

export class LayoutError extends Error {
  readonly missing: string[]

  constructor(message: string, missing: string[] = []) {
    super(message)
    this.name = 'LayoutError'
    this.missing = missing
  }
}

/** 向上查找项目根的标记目录（开发态特征） */
const PROJECT_MARKERS = ['workspace', 'portable'] as const
const MAX_UPWARD = 6

/**
 * 交付根探测（D2-28 新布局，向上找，**与运行时嵌套层级无关**）：
 * 同时满足 ① 有 data/ 与 environment/；② 有 query/main.js（程序根就在 query/，与 workspace/query 同构，D2-29）。
 * 第 ② 条同时挡住开发态的 workspace/（它也有 data/ 与 environment/，但没有 query/main.js）。
 */
function findDeliveryRoot(appRoot: string): string | null {
  let dir = appRoot
  for (let i = 0; i < MAX_UPWARD; i++) {
    const parent = dirname(dir)
    if (parent === dir) break
    if (
      existsSync(join(parent, 'data')) &&
      existsSync(join(parent, 'environment')) &&
      existsSync(join(parent, 'query', 'main.js'))
    ) {
      return parent
    }
    dir = parent
  }
  return null
}

function findProjectRoot(startDir: string): string | null {
  let dir = startDir
  for (let i = 0; i < MAX_UPWARD; i++) {
    if (PROJECT_MARKERS.every((m) => existsSync(join(dir, m)))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function assemble(
  mode: LayoutMode,
  appRoot: string,
  programRoot: string,
  runtimeRoot: string,
  dataDir: string,
  environmentDir: string,
): AppPaths {
  const runtimeDir = join(dataDir, 'runtime')
  return {
    mode,
    appRoot,
    programRoot,
    runtimeRoot,
    binRoot: runtimeRoot,
    configDir: join(programRoot, 'config'),
    frontendIndex: join(programRoot, 'frontend', 'index.html'),
    dataDir,
    environmentDir,
    runtimeDir,
    logsDir: join(runtimeDir, 'logs'),
    llamacppDir: join(environmentDir, 'llamacpp'),
    modelsDir: join(environmentDir, 'models'),
    chromiumDir: join(runtimeDir, 'chromium'),
  }
}

/**
 * 【纯函数 · D2-10】从 appRoot 算出全部路径 —— **不依赖 Electron**。
 *
 * 为什么要拆出来：`utilityProcess` 是**纯 Node 环境、没有完整的 Electron API** ——
 * **实测（2026-09-27）**：worker 里 `require('electron')` **不抛错**，但只拿到
 * `{ net, systemPreferences }` 两个成员（**没有 `app`**），所以 `app.getAppPath()` 会在
 * 运行时 `TypeError`，构建期完全不报（问题 12/13 那一类）。
 * 所以由**主进程**取一次 `app.getAppPath()`，把算好的 AppPaths 注入 worker；
 * 解析逻辑仍然只在本模块（红线 R2 成立：路径解析只出现在 launcher/bootstrap）。
 *
 * 实测证据：交接文档/验收记录/目标2/02-utilityprocess.md。
 */
export function resolvePathsFrom(appRoot: string): AppPaths {
  // 交付态（D2-28 新布局）：<交付根>/query = 程序树（与 workspace/query 同名同构）
  //                        <交付根>/query/bin = Electron 运行时（含 resources/app 跳板）
  const deliveryRoot = findDeliveryRoot(appRoot)
  if (deliveryRoot) {
    const programRoot = join(deliveryRoot, 'query')
    return assemble(
      'portable',
      appRoot,
      programRoot,
      join(deliveryRoot, 'bin'),
      join(deliveryRoot, 'data'),
      join(deliveryRoot, 'environment'),
    )
  }

  // 开发态：appRoot = <项目根>/workspace/query/bin/bin/resources/app（D2-28 统一布局）
  const runtimeRoot = dirname(dirname(appRoot))
  const projectRoot = findProjectRoot(runtimeRoot)
  if (projectRoot) {
    // 程序根：运行时根的上一级若有 main.js（统一布局），就是程序根；否则退回 appRoot（旧布局兼容）
    const parentOfRuntime = dirname(runtimeRoot)
    const programRoot = existsSync(join(parentOfRuntime, 'main.js')) ? parentOfRuntime : appRoot
    return assemble(
      'development',
      appRoot,
      programRoot,
      runtimeRoot,
      join(projectRoot, 'workspace', 'data'),
      join(projectRoot, 'workspace', 'environment'),
    )
  }

  const expectPortable =
    join(dirname(dirname(runtimeRoot)), 'data') + ' 与 ' + join(dirname(dirname(runtimeRoot)), 'environment') +
    ' 与 ' + join(dirname(dirname(runtimeRoot)), 'query', 'main.js')
  throw new LayoutError(
    [
      '无法判定布局形态：既不是交付态，也不是开发态。',
      '  · 交付态需要：' + expectPortable + ' 同时存在；',
      '  · 开发态需要：从 ' + runtimeRoot + ' 向上找到同时含 workspace/ 与 portable/ 的项目根。',
      '  → 程序必须 query/（程序树）+ query/bin/（运行时）+ data/ + environment/ 同在，不可单独复制 query/。',
    ].join('\n'),
    [expectPortable],
  )
}

/** 主进程入口：取 `app.getAppPath()` 后交给纯函数；**全项目唯一解析处仍是本模块**（红线 R2） */
export function resolvePaths(): AppPaths {
  return resolvePathsFrom(app.getAppPath())
}

/** 启动时必须打印的那一行（施工单 §6.2：说明 mode 与关键路径） */
export function describePaths(p: AppPaths): string {
  return [
    'mode=' + p.mode,
    'appRoot=' + p.appRoot,
    'programRoot=' + p.programRoot,
    'runtimeRoot=' + p.runtimeRoot,
    'data=' + p.dataDir,
    'environment=' + p.environmentDir,
    'runtime=' + p.runtimeDir,
  ].join(' ')
}

/** 建立唯一可写目录（runtime/logs）；只创建、不清理 */
export function ensureRuntimeDirs(p: AppPaths): void {
  mkdirSync(p.logsDir, { recursive: true })
}

/**
 * 启动自检（施工单 §18.4）——逐项查，**缺任何一项都返回明确说明**，绝不静默。
 * 返回空数组表示全部通过；调用方负责把问题弹框告知用户。
 *
 * 放在 bootstrap 里的理由：它需要 AppPaths，且 §18.4 明确允许"launcher/bootstrap 或 launcher/diagnostics"。
 */
export function selfCheck(p: AppPaths): string[] {
  const problems: string[] = []

  // ① 运行时根的 Electron 运行时（缺了根本起不来，这里兜底给出可读提示）
  const runtimeMarkers = ['icudtl.dat', 'resources.pak']
  const missingRuntime = runtimeMarkers.filter((f) => !existsSync(join(p.runtimeRoot, f)))
  if (missingRuntime.length > 0) {
    problems.push('运行时文件缺失（可能解压不完整）：' + missingRuntime.join('、') + '\n  位置：' + p.runtimeRoot)
  }

  // ② 程序本体（程序根 = 与 query 同构的那一层）
  const mainJs = join(p.programRoot, 'main.js')
  if (!existsSync(mainJs)) problems.push('程序文件缺失：' + mainJs)
  // 程序清单：交付态在运行时根的 resources/app（跳板）；开发态就在程序根
  const appPkg = [join(p.runtimeRoot, 'resources', 'app', 'package.json'), join(p.programRoot, 'package.json')]
    .find((f) => existsSync(f))
  if (!appPkg) problems.push('程序清单缺失：' + join(p.runtimeRoot, 'resources', 'app', 'package.json'))

  // ③ 解释器
  const serverExe = join(p.llamacppDir, 'cpu', 'llama-server.exe')
  if (!existsSync(serverExe)) problems.push('模型服务程序缺失：' + serverExe)

  // ④ 三个模型（目标 2.5：回答 + Embedding + Reranker）——只查目录里有没有 .gguf，
  //    具体文件名由 config/models 决定，不在此处写死（bootstrap 不读配置，保持「只解析路径」的职责）
  const modelRoles: Array<[string, string]> = [
    ['answer', '回答模型'],
    ['embedding', 'Embedding 模型'],
    ['reranker', 'Reranker 模型'],
  ]
  for (const [dir, label] of modelRoles) {
    const d = join(p.modelsDir, dir)
    const hasGguf = existsSync(d) && readdirSync(d).some((f) => f.toLowerCase().endsWith('.gguf'))
    if (!hasGguf) problems.push(label + '缺失（目录下没有 .gguf）：' + d)
  }

  // ⑤ 可写目录
  try {
    mkdirSync(p.logsDir, { recursive: true })
    const probe = join(p.runtimeDir, '.write-probe')
    writeFileSync(probe, 'ok')
    rmSync(probe, { force: true })
  } catch (err) {
    problems.push('运行数据目录不可写：' + p.runtimeDir + '\n  ' + (err as Error).message +
      '\n  → 程序目录可能被设为只读，或该目录的权限不足。')
  }

  return problems
}
