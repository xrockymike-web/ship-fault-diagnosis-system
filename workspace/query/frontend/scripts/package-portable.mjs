#!/usr/bin/env node
/**
 * 阶段 1.6 便携组装脚本 —— 把三兄弟组装成 portable/（施工单 §18）。
 *
 * 用法：node scripts/package-portable.mjs
 *
 * 规则（§18.2，逐条对应）：
 *   1. **来源必须干净**：运行时与模型取自 workspace/environment/，程序取自构建产物
 *      （query/bin/resources/app）—— **不从 query/bin/ 整包搬**，避免把调试残留带进交付物。
 *   2. portable/bin **清空重建**（仅保留 README.md）。
 *   3. 大文件**增量复制**：目标已存在且大小一致则跳过（仍是真实文件，不是链接）。
 *   4. **Electron 运行时放两份**（负责人 2026-09-27 决定，见 §18.2）：
 *      bin/ 自带一份（程序启动必需）+ environment/electron/ 一份干净副本（用于修复/重建）。
 *      代价 +367 MB，交付包约 1.43 GB（验收第 10 条已改为 ≤2 GB）。
 *
 * 本脚本**不产出 ZIP**（§18.8：ZIP 等阶段 1 全部结束后再压）；也不做 asar 重打包（目标 8）。
 */
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url)) // query/frontend/scripts
const QUERY_DIR = join(HERE, '..', '..') // query/
const PROJECT_ROOT = join(QUERY_DIR, '..', '..') // 项目根
const WORKSPACE = join(PROJECT_ROOT, 'workspace')
const SRC_ENV = join(WORKSPACE, 'environment')
const SRC_APP = join(QUERY_DIR, '..', 'bin', 'resources', 'app') // 构建产物 = 程序树（D2-31 乙）
const DST = join(PROJECT_ROOT, 'portable')
const PRODUCT_EXE = '船舶故障诊断系统.exe'
// 一级入口（启动器 + 兜底 bat）由 0.5 段落成 —— 与 bin/ 内的 PRODUCT_EXE 同名不同层，注意区分
/** 开发侧的来源/自检记录，不进交付物 */
const SKIP_NAMES = new Set(['SOURCE.txt', 'verify-runtime.cjs'])

/** 产品版本号唯一源（D2-17） */
const APP_VERSION = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version

const t0 = Date.now()
const stats = { copied: 0, skipped: 0 }

function fail(msg) {
  console.error('[portable] ✗ ' + msg)
  process.exit(1)
}

function copyIncremental(srcDir, dstDir, skip = null, relBase = '') {
  mkdirSync(dstDir, { recursive: true })
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name)) continue
    const rel = relBase ? relBase + '/' + entry.name : entry.name
    if (skip && skip(rel)) continue
    const s = join(srcDir, entry.name)
    const d = join(dstDir, entry.name)
    if (entry.isDirectory()) {
      copyIncremental(s, d, skip, rel)
      continue
    }
    // ⚠️ 只比大小是**不够的**（2026-09-27 实测踩坑）：内容变了但字节数相同的文件会被永远跳过。
    //    判据改为「大小相同 **且** 目标不比源旧」。
    const sd = statSync(s)
    if (existsSync(d) && statSync(d).size === sd.size && statSync(d).mtimeMs >= sd.mtimeMs) {
      stats.skipped += 1
      continue
    }
    copyFileSync(s, d)
    stats.copied += 1
  }
}

function dirSizeMiB(dir) {
  let total = 0
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else total += statSync(p).size
    }
  }
  if (existsSync(dir)) walk(dir)
  return Math.round((total / 1024 / 1024) * 10) / 10
}

// ---------- 0. 前置检查 ----------
if (!existsSync(join(SRC_ENV, 'electron', 'electron.exe'))) fail('缺少 Electron 运行时：' + join(SRC_ENV, 'electron'))
if (!existsSync(join(SRC_APP, 'main.js'))) fail('缺少构建产物：' + join(SRC_APP, 'main.js') + '（请先在 frontend/ 跑 npm run build）')
if (!existsSync(join(SRC_ENV, 'llamacpp', 'cpu', 'llama-server.exe'))) fail('缺少 llama-server.exe（CPU 版）')
// 目标 2.6（D2-3）：交付物必须**双版齐全** —— 有 N 卡走 cuda/，没 N 卡靠 cpu/ 兜底；
// 缺一版就是"在某种机器上跑不起来"，宁可现在就失败（不静默降级）。
if (!existsSync(join(SRC_ENV, 'llamacpp', 'cuda', 'llama-server.exe'))) {
  fail('缺少 CUDA 版 llama-server：' + join(SRC_ENV, 'llamacpp', 'cuda') +
    '\n  → 目标 2 起交付物必须同时含 CPU 与 CUDA 两版（《技术路线总纲》§7.4.6 校验清单）')
}
// 🆕 2026-10-09（异机鲁棒性预检 · 只增不改）：VC++ 运行库三件套必须随包，CPU / CUDA 两版都要有。
//    llama-server.exe 依赖它们，而**干净 Windows 不自带**（总纲 §7.4.6 已列）。开发机装过 VC++ 永远测不出来，
//    缺了只会在**别人的电脑**上炸成"找不到 vcruntime140.dll"—— 所以放到打包时拦。
const VCRUNTIME_DLLS = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']
for (const flavor of ['cpu', 'cuda']) {
  const dir = join(SRC_ENV, 'llamacpp', flavor)
  for (const dll of VCRUNTIME_DLLS) {
    if (!existsSync(join(dir, dll))) {
      fail('缺少 VC++ 运行库 ' + dll + '：' + join(dir, dll) +
        '\n  → llama-server.exe 依赖它，干净 Windows 不自带（《技术路线总纲》§7.4.6 校验清单）')
    }
  }
}
const answerDir = join(SRC_ENV, 'models', 'answer')
const embDir = join(SRC_ENV, 'models', 'embedding')
const rerDir = join(SRC_ENV, 'models', 'reranker')
/**
 * 🆕 v0.3.2：**CPU 档专用**的 Q4_K_M 回答模型（`config/models` 的 `cpu.answer.modelDir=answer-q4km`）。
 * 为什么必须随包：负责人 2026-10-12 定「CPU 路换 Q4、GPU 路留 Q8」→ **两个都要带**。
 * ⚠️ 代价：包体 ≈3776 → ≈4154 MiB，**跨过 4 GB（触发 zip64）**。
 */
const q4kmDir = join(SRC_ENV, 'models', 'answer-q4km')
for (const [label, dir] of [['回答模型', answerDir], ['Embedding 模型', embDir], ['Reranker 模型', rerDir], ['回答模型·CPU 档 Q4_K_M', q4kmDir]]) {
  const g = existsSync(dir) ? readdirSync(dir).find((f) => f.toLowerCase().endsWith('.gguf')) : undefined
  if (!g) fail('缺少' + label + '（' + dir + ' 下没有 .gguf）\n  → 目标 2.5 起交付物必须含三个模型（《技术路线总纲》§7.4.6）；CPU 档还要多带一个 Q4_K_M')
}
// 🆕 2026-10-09（异机鲁棒性预检 · 只增不改）：再按 config/models/default.json 的**指定文件名**核对。
//    上一条只看"有没有 .gguf" —— 放错模型、下错量化照样过；配置是唯一事实源，这里只读它、不写死第二份。
const modelsCfgFile = join(SRC_APP, 'config', 'models', 'default.json')
if (!existsSync(modelsCfgFile)) fail('缺少模型配置（无法核对模型文件名）：' + modelsCfgFile)
let modelsCfg
try { modelsCfg = JSON.parse(readFileSync(modelsCfgFile, 'utf8')) } catch (err) { fail('模型配置无法解析：' + modelsCfgFile + '\n  ' + err.message) }
for (const [label, dir, role] of [['回答模型', answerDir, 'answer'], ['Embedding 模型', embDir, 'embedding'], ['Reranker 模型', rerDir, 'reranker']]) {
  const want = modelsCfg[role] && modelsCfg[role].gguf
  if (!want) fail('config/models/default.json 缺 ' + role + '.gguf 字段')
  if (!existsSync(join(dir, want))) {
    fail('缺少' + label + '指定文件 ' + want + '：' + join(dir, want) +
      '\n  → 配置（config/models/default.json）要求这个文件名；目录里实际有：' +
      (existsSync(dir) ? readdirSync(dir).join(', ') : '(目录不存在)'))
  }
}
// 🆕 v0.3.2：**CPU 档覆盖块指定的模型**也要按文件名核对（顶层值 = GPU 档，`cpu` 块 = CPU 档）
if (modelsCfg.cpu && modelsCfg.cpu.answer && modelsCfg.cpu.answer.gguf) {
  const cpuDir = join(SRC_ENV, 'models', modelsCfg.cpu.answer.modelDir || 'answer')
  if (!existsSync(join(cpuDir, modelsCfg.cpu.answer.gguf))) {
    fail('缺少CPU 档指定文件 ' + modelsCfg.cpu.answer.gguf + '：' + join(cpuDir, modelsCfg.cpu.answer.gguf) +
      '\n  → config/models/default.json 的 `cpu.answer` 要求这个文件名；目录里实际有：' +
      (existsSync(cpuDir) ? readdirSync(cpuDir).join(', ') : '(目录不存在)'))
  }
} else {
  fail('config/models/default.json 缺 `cpu.answer.gguf`（v0.3.2 起 CPU 档必须指名自己的回答模型）')
}

// ---------- 0.4 构建产物新鲜度（2026-09-27 修复）：绝不把旧代码组装进交付物 ----------
// 真实事故：改了版本号却没重新 build，组装脚本照样把**上一版**的 resources/app 打进了 portable 与 ZIP，
// 结果交付包里 bin/resources/app/package.json 写着 0.1.0、bin/manifest.json 写着 0.2.0。
const SCAN_SKIP = ['\\bin\\', '\\node_modules\\', '\\scripts\\build\\', '\\.git\\']
const SCAN_SKIP_FILE = /\.(gitkeep|tsbuildinfo|ps1|cs|cjs|log)$/i
function newestMtime(dir, isSource) {
  let newest = 0
  let where = ''
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) {
        if (SCAN_SKIP.some((s) => (p + '\\').includes(s))) continue
        walk(p)
        continue
      }
      if (SCAN_SKIP_FILE.test(e.name)) continue
      if (!isSource && (p + '\\').includes('\\bin\\bin\\')) continue // 运行时子树不参与新鲜度判断
      if (isSource && p.includes('\\frontend\\scripts\\')) continue
      if (isSource && /package-lock\.json$/i.test(e.name)) continue
      const m = statSync(p).mtimeMs
      if (m > newest) { newest = m; where = p }
    }
  }
  walk(dir)
  return { newest, where }
}
const newestOut = newestMtime(SRC_APP, false)
const newestSrc = newestMtime(QUERY_DIR, true)
if (newestSrc.newest > newestOut.newest) {
  fail('构建产物比源码旧：' +
    '\n  最新源码 ' + new Date(newestSrc.newest).toISOString() + '  ' + newestSrc.where +
    '\n  最新产物 ' + new Date(newestOut.newest).toISOString() + '  ' + newestOut.where +
    '\n  → 请先在 frontend/ 跑 npm run build 再组装（拒绝把旧代码打进交付物）')
}
console.log('[portable] 新鲜度检查 ✓（产物不旧于源码）')

// ---------- 0.5 一级入口（目标 2.6b / D2-6）：先删旧的，再落新的 ----------
// 为什么要先删（P23）：组装失败或改了名字时，一级会留下**上一版**的启动器，
// 而验收「双击一级 exe」就会测到旧货。
const PRODUCT_LAUNCHER = '船舶故障诊断系统.exe'
const BAT_NAME = '启动.bat'
const SRC_LAUNCHER = join(HERE, 'build', 'launcher.exe')
for (const f of [PRODUCT_LAUNCHER, BAT_NAME]) {
  rmSync(join(DST, f), { force: true })
}
if (!existsSync(SRC_LAUNCHER)) {
  fail('缺少一级启动器：' + SRC_LAUNCHER +
    '\n  → 先跑 npm run build:launcher（用系统自带 csc.exe 编译，零下载）')
}
copyFileSync(SRC_LAUNCHER, join(DST, PRODUCT_LAUNCHER))
// 兜底 bat：**内容保持纯 ASCII**（用 for 通配拿 exe），避免中文在 cmd 的 936 代码页下乱码（P21）
writeFileSync(join(DST, BAT_NAME),
  '@echo off\r\n' +
  'rem Fallback entry: if the .NET launcher fails, this still starts the app.\r\n' +
  'rem ASCII-only on purpose: cmd.exe reads .bat in the OEM code page (936 on this machine).\r\n' +
  'for %%f in ("%~dp0bin\\*.exe") do start "" "%%~ff"\r\n')

// ---------- 1. bin/：**与 workspace/query 同构的程序树**；bin/bin/ = Electron 运行时（D2-28）----------
// 结构（负责人 2026-09-27 指示）：
//   bin/            ← 对应 workspace/query/  ：main.js preload.js qa-core/ launcher/ config/ frontend/ …
//   bin/bin/        ← 对应 workspace/query/bin/ ：入口 exe + *.dll/*.pak + locales/ + resources/app（跳板）
const PROGRAM = join(DST, 'query')   // 交付态程序树（D2-29/D2-31）
const PROGRAM_RUNTIME = join(DST, 'bin')   // 交付态运行时（与程序树平级，D2-31 乙）
mkdirSync(PROGRAM, { recursive: true })
// 清空重建（§18.2）——但保留 README.md 与 .gitkeep：
// 后者是源码侧的目录占位标记（D-D 决定让骨架进 git），不该被组装动作删掉。
const keepMarkers = []
const collectMarkers = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) { if (e.name === 'bin') continue; collectMarkers(p) }  // 运行时子树不收集占位
    else if (e.name === '.gitkeep') keepMarkers.push(p.slice(PROGRAM.length + 1))
  }
}
collectMarkers(PROGRAM)
for (const entry of readdirSync(PROGRAM)) {
  if (entry === 'README.md' || entry === '.gitkeep') continue
  rmSync(join(PROGRAM, entry), { recursive: true, force: true })
}
for (const rel of keepMarkers) {
  const p = join(PROGRAM, rel)
  mkdirSync(dirname(p), { recursive: true })
  if (!existsSync(p)) writeFileSync(p, '')
}
// ① 程序本体（构建产物本身就是这个形状）→ bin/ 根；跳过它自带的运行时子树 bin/bin/（下面用干净副本）
copyIncremental(SRC_APP, PROGRAM)   // 产物树里已经没有运行时子树了，整拷即可（D2-31 乙）
// ② Electron 运行时进 bin/bin/
mkdirSync(PROGRAM_RUNTIME, { recursive: true })
copyIncremental(join(SRC_ENV, 'electron'), PROGRAM_RUNTIME)
// 入口 exe 用**改名**而不是再复制一份（运行时目录里只该有一个入口 exe）
const binOriginal = join(PROGRAM_RUNTIME, 'electron.exe')
const binProduct = join(PROGRAM_RUNTIME, PRODUCT_EXE)
if (existsSync(binOriginal)) {
  if (existsSync(binProduct)) rmSync(binProduct, { force: true })
  renameSync(binOriginal, binProduct)
}
// ③ 跳板：Electron 只从 <exe 同级>/resources/app 加载程序（实测，见验收记录 阶段1.2/02b），
//    而程序本体在 bin/ 根，所以这里放一份 loader 把执行权交回去（三级 .. = app→resources→bin(运行时)→bin(程序根)）。
mkdirSync(join(PROGRAM_RUNTIME, 'resources', 'app'), { recursive: true })
writeFileSync(join(PROGRAM_RUNTIME, 'resources', 'app', 'package.json'),
  JSON.stringify({ name: 'ship-diagnosis', version: APP_VERSION, main: 'loader.js' }, null, 2) + '\n')
writeFileSync(join(PROGRAM_RUNTIME, 'resources', 'app', 'loader.js'),
  '// 交付态跳板（D2-28）：Electron 的 app 目录固定是 <exe 同级>/resources/app，\n' +
  '// 而程序本体在 <交付根>/bin（与 workspace/query 同构的那一层），这里把执行权交回真正的 main.js。\n' +
  "require('../../../query/main.js')\n")   // app → resources → bin → 交付根，共三级

// ---------- 2. data/：骨架 + 两处可写目录（runtime / user_data） ----------
const DATA = join(DST, 'data')
for (const d of ['graph', 'chunk', 'document', 'vector-index/chunk/vector', 'vector-index/graph/vector', 'runtime/logs', 'user_data']) {
  mkdirSync(join(DATA, d), { recursive: true })
}
// ---------- 2b. 知识库本体：两库 + 装箱单（目标 4 起**必须随包**；2026-10-19 起为两库） ----------
//   2026-10-07 补：原脚本只建骨架、不拷库 → 打出来的包**检索不了**。这里按 §7.4.4 白名单复制。
const SRC_VECIDX = join(WORKSPACE, 'data', 'vector-index')
if (!existsSync(SRC_VECIDX)) fail('找不到知识库目录：' + SRC_VECIDX)
let kbBytes = 0
for (const n of ['chunk', 'graph']) {
  const s = join(SRC_VECIDX, n, n + '.sqlite')
  if (!existsSync(s)) fail('缺少检索库 ' + n + '.sqlite（先跑 4.2 建库）：' + s)
  const d = join(DATA, 'vector-index', n, n + '.sqlite')
  copyFileSync(s, d)
  kbBytes += statSync(d).size
}
const srcManifest = join(SRC_VECIDX, 'manifest.json')
if (!existsSync(srcManifest)) fail('缺少交付装箱单 data/vector-index/manifest.json（先跑 4.3）')
copyFileSync(srcManifest, join(DATA, 'vector-index', 'manifest.json'))

// 2026-10-25：英文层源资产随包（运行时数据已在两库里，这三个文件用于核对与重建）
for (const rel of ['chunk/chunks_en.jsonl', 'graph/entities_en.csv', 'graph/labels_en.csv']) {
  const src = join(WORKSPACE, 'data', rel)
  if (!existsSync(src)) continue
  const dst = join(DATA, rel)
  mkdirSync(dirname(dst), { recursive: true })
  copyFileSync(src, dst)
}
kbBytes += statSync(srcManifest).size
console.log('[portable] 知识库两库 + 装箱单：' + (kbBytes / 1048576).toFixed(1) + ' MiB')

// 空目录进不了 ZIP：给 data/ 里每个空目录补一行说明（知识库骨架要留下来）
const ensureNoEmpty = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const p = join(dir, e.name)
    if (readdirSync(p).length === 0) {
      writeFileSync(join(p, 'README.txt'),
        e.name + '/ —— 目录占位（目标 3 起放知识库内容）\n\n' +
        '留这份说明是为了让目录本身能进 ZIP —— 打包工具会跳过空目录。\n' +
        '运行数据只写 data/runtime/，本目录对程序是只读的。\n')
      continue
    }
    // runtime / user_data 有各自的说明文件，不走通用占位
    if (e.name !== 'runtime' && e.name !== 'user_data') ensureNoEmpty(p)
  }
}
ensureNoEmpty(DATA)

// 目标 2.7：**组装出干净的交付物** —— 清掉上次运行留下的会话/缓存/日志（ZIP 白名单同样会挡，
// 但更早清掉能保证 package:portable 之后 package 就能直接过）。只保留说明文件。
let purged = 0
for (const e of readdirSync(join(DATA, 'runtime'))) {
  if (e === 'README.txt' || e === 'logs') continue
  rmSync(join(DATA, 'runtime', e), { recursive: true, force: true })
  purged += 1
}
// logs 目录只留空壳
for (const e of readdirSync(join(DATA, 'runtime', 'logs'))) {
  rmSync(join(DATA, 'runtime', 'logs', e), { recursive: true, force: true })
  purged += 1
}
if (purged > 0) console.log('[portable] data/runtime 已清空 ' + purged + ' 项（会话/日志/缓存不进交付物）')

// U1：**用户知识库也要清空** —— 交付物绝不带任何用户内容（目录与说明保留）
let purgedKb = 0
for (const e of readdirSync(join(DATA, 'user_data'))) {
  if (e === 'README.txt') continue
  rmSync(join(DATA, 'user_data', e), { recursive: true, force: true })
  purgedKb += 1
}
if (purgedKb > 0) console.log('[portable] data/user_data 已清空 ' + purgedKb + ' 项（用户知识库不进交付物）')

// ⚠️ 空目录在 ZIP 里活不下来（Compress-Archive 会跳过），而"程序靠 <bin>/../data 存在"来判定 portable 形态。
//    所以这里放两个**说明文件**：既保住目录，又把"这里存了什么、能不能删"写清楚（总纲 §5.11 的隐私建议）。
writeFileSync(join(DATA, 'README.txt'),
  'data/ —— 知识库与运行数据\n' +
  '========================================\n' +
  'graph/ document/ chunk/ vector-index/   知识库（只读，不随用户改动）\n' +
  'runtime/                                运行数据（可写）：会话库、日志、硬件缓存\n' +
  'user_data/                              你自己加的知识（可写）：文本 / 图节点 / 三元组\n\n' +
  '内置知识库对程序是只读的；写入只集中在 runtime/ 与 user_data/ 两处。\n' +
  '要"恢复出厂"：删掉 runtime/（历史会话消失）或 user_data/（自建知识消失），下次启动自动重建。\n')
writeFileSync(join(DATA, 'user_data', 'README.txt'),
  'user_data/ —— 你自己加的知识在这里\n' +
  '========================================\n' +
  'user-kb.sqlite    自建知识库：文本 / 图节点（实体）/ 三元组\n\n' +
  '· 这里面的内容**只属于你**，程序不会把它写进内置知识库，也不会随程序升级被改动。\n' +
  '· 交付包里这个目录是空的：打包时已清空（免得把你的私人内容发出去）。\n' +
  '· 想备份就整个目录拷走；想清空就整个目录删掉（下次启动自动重建为空库）。\n')
writeFileSync(join(DATA, 'runtime', 'README.txt'),
  'runtime/ —— 你的对话记录在这里\n' +
  '========================================\n' +
  'sessions.sqlite   会话与消息（含你问过的每一句话）\n' +
  'hardware.json     上次检测到的运行后端（cuda/cpu）与是否已提示过\n' +
  'logs/             运行日志（排障用）\n' +
  'chromium/         界面缓存（可随时删）\n\n' +
  '整个目录可以随时删除：程序下次启动会重建，只是历史会话会一并消失。\n' +
  '本程序不联网，这些内容不会离开这台电脑。\n')

// 🆕 2026-10-16：第三方许可声明进交付根目录（SoftwareX 等场景要求"随包可查"）。
//    源文件在 frontend/public/ 下，会被 vite 原样拷进构建产物；这里显式再放一份到根，
//    确保解压后**根目录第一眼就能看到**。
try {
  const tpn = join(HERE, '..', 'public', 'THIRD-PARTY-NOTICES.txt')
  if (existsSync(tpn)) {
    copyFileSync(tpn, join(DST, '第三方组件与许可.txt'))
    console.log('[portable] 第三方组件与许可.txt 已放入交付根目录')
  } else {
    console.log('[portable] ⚠ 未找到 public/THIRD-PARTY-NOTICES.txt（跳过，不阻断）')
  }
} catch (err) { console.log('[portable] ⚠ 第三方许可拷贝失败（不阻断）：' + err.message) }

// 🆕 2026-10-09（异机鲁棒性 · 交付根说明，只增不改）：
//    用户在**别人的电脑**上第一次双击时最需要知道的四件事：为什么慢、被 Windows 拦了怎么办、
//    别解压到哪、没有显卡能不能用。写在这里 → 由 package-zip 显式打进 ZIP 根目录。
//    ⚠️ 文件名不许改成 SOURCE.txt / PERF.txt —— 那两个在 ZIP 禁令名单里。
const FIRST_RUN_NOTE = '首次启动说明.txt'
writeFileSync(join(DST, FIRST_RUN_NOTE), '\uFEFF' +
  '船舶故障诊断系统 —— 首次启动说明\r\n' +
  '================================================\r\n' +
  '\r\n' +
  '一、第一次打开比较慢，第二次起明显变快，这是正常的\r\n' +
  '  第一次启动时：Windows 要扫描本程序的文件、系统要建立界面缓存、\r\n' +
  '  程序还要检测这台电脑有没有能用的 NVIDIA 显卡，并加载三个本地模型。\r\n' +
  '  开发机实测参考：首次启动到「模型就绪」约 6.6 秒，第二次约 5.2 秒。\r\n' +
  '  如果是机械硬盘或从 U 盘运行，第一次会更慢（要读约 1.8 GB 模型文件），第二次起恢复正常。\r\n' +
  '\r\n' +
  '二、如果 Windows 提示「已保护你的电脑」，或杀毒软件拦了\r\n' +
  '  1) 右键「船舶故障诊断系统.exe」→ 属性 → 勾选「解除锁定」→ 确定，再双击；\r\n' +
  '     或双击后点「更多信息」→「仍要运行」。\r\n' +
  '  2) 若文件被杀毒软件隔离，请在杀毒软件里选择「恢复 / 信任本文件夹」。\r\n' +
  '  3) 本程序完全离线运行，不联网、不需要管理员权限、不写注册表。\r\n' +
  '\r\n' +
  '三、解压位置要注意\r\n' +
  '  · 不要解压到 OneDrive、网络共享或云同步目录（会让首次打开极慢，离线时还可能打不开）。\r\n' +
  '  · 建议解压到本地磁盘的任意目录（例如 D 盘下的某个文件夹）。\r\n' +
  '  · 整个文件夹可以改名、移动、拷到 U 盘带走；但不要单独挪动里面的某个子文件夹。\r\n' +
  '\r\n' +
  '四、有没有独立显卡都能用\r\n' +
  '  · 有 NVIDIA 显卡：自动用显卡加速。\r\n' +
  '  · 没有显卡：程序会提示一次，然后改用 CPU 运行 —— 功能完全一样，只是回答慢一些。\r\n' +
  '\r\n' +
  '五、恢复出厂（这两个目录随时可删，内置知识库不受影响）\r\n' +
  '  · 删掉 data\\runtime\\     → 历史会话清空，下次启动自动重建\r\n' +
  '  · 删掉 data\\user_data\\   → 你自己录入的知识清空\r\n' +
  '  · 本程序不联网，这些内容不会离开这台电脑。\r\n')

// ---------- 3. environment/：镜像（可裁剪） ----------
const ENV = join(DST, 'environment')
copyIncremental(join(SRC_ENV, 'electron'), join(ENV, 'electron'))
copyIncremental(join(SRC_ENV, 'llamacpp', 'cpu'), join(ENV, 'llamacpp', 'cpu'))
copyIncremental(join(SRC_ENV, 'llamacpp', 'cuda'), join(ENV, 'llamacpp', 'cuda')) // 目标 2.6：CUDA 版 + cudart
copyIncremental(answerDir, join(ENV, 'models', 'answer'))
copyIncremental(embDir, join(ENV, 'models', 'embedding'))   // 目标 2.5：Embedding 模型（609.5 MiB）
copyIncremental(rerDir, join(ENV, 'models', 'reranker'))    // 目标 2.5：Reranker 模型（609.5 MiB，第三方 GGUF）
copyIncremental(q4kmDir, join(ENV, 'models', 'answer-q4km')) // 🆕 v0.3.2：CPU 档 Q4_K_M（378.3 MiB）

// ---------- 4. manifest.json 草案（§7.7 / §18.1 第 5 条） ----------
const electronVersion = readFileSync(join(SRC_ENV, 'electron', 'version'), 'utf8').trim()
// resources.json（模型/环境来源台账）随版权清洗移除（2026-10-16）—— 缺失时降级为空台账，manifest 对应字段留空
const resourcesPath = join(WORKSPACE, 'data', 'resources.json')
const resources = existsSync(resourcesPath)
  ? JSON.parse(readFileSync(resourcesPath, 'utf8'))
  : { resources: [] }
const modelRec = resources.resources.find((r) => r.id === 'MODEL-ANSWER') ?? {}
const embRec = resources.resources.find((r) => r.id === 'MODEL-EMBEDDING') ?? {}
const rerRec = resources.resources.find((r) => r.id === 'MODEL-RERANKER') ?? {}
const llamacppRec = resources.resources.find((r) => r.id === 'ENV-LLAMACPP-CPU') ?? {}
const cudaRec = resources.resources.find((r) => r.id === 'ENV-LLAMACPP-CUDA') ?? {}
const manifest = {
  product: '船舶故障诊断系统',
  version: APP_VERSION,
  stage: 'release',
  assembledAt: new Date().toISOString(),
  components: {
    electron: { version: electronVersion, copies: 'bin/ (launcher) + environment/electron/ (reference copy)' },
    llamacpp: {
      cpu: { version: llamacppRec.version, sizeMiB: llamacppRec.size_mb },
      cuda: { version: cudaRec.version, flavor: cudaRec.flavor, sizeMiB: cudaRec.size_mb },
    },
    models: {
      answer: {
        file: modelRec.file, quantization: modelRec.quantization,
        sizeMiB: modelRec.size_mb, sha256: modelRec.sha256, license: modelRec.license,
      },
      embedding: {
        file: embRec.file, quantization: embRec.quantization, dim: embRec.dim,
        sizeMiB: embRec.size_mb, sha256: embRec.sha256, license: embRec.license,
      },
      reranker: {
        file: rerRec.file, quantization: rerRec.quantization,
        sizeMiB: rerRec.size_mb, sha256: rerRec.sha256, license: rerRec.license,
        note: 'Community GGUF conversion; see query/frontend/THIRD-PARTY-NOTICES.txt for source and license.',
      },
    },
  },
  sizesMiB: { query: dirSizeMiB(PROGRAM), bin: dirSizeMiB(PROGRAM_RUNTIME), environment: dirSizeMiB(ENV), data: dirSizeMiB(DATA) },
  note: 'Per-file checksums are published with the source repository (SHA256SUMS.txt at the repository root).',
}
// manifest 放运行时目录（程序根保持与 query/ 同构，不掺私货）
writeFileSync(join(PROGRAM_RUNTIME, 'manifest.json'), JSON.stringify({ ...manifest, scope: 'bin' }, null, 2) + '\n')
writeFileSync(join(ENV, 'manifest.json'), JSON.stringify({ ...manifest, scope: 'environment' }, null, 2) + '\n')

const totalMiB = dirSizeMiB(DST)
console.log(
  '[portable] ✓ ' + DST +
  '\n           query ' + manifest.sizesMiB.query + ' MiB（程序树 + 运行时）' +
  '\n           environment ' + manifest.sizesMiB.environment + ' MiB（运行时干净副本 + llama.cpp + 模型）' +
  '\n           data ' + manifest.sizesMiB.data + ' MiB（骨架）' +
  '\n           **合计 ' + totalMiB + ' MiB ≈ ' + (totalMiB / 1024).toFixed(2) + ' GiB**' +
  '\n           复制 ' + stats.copied + ' 个文件，跳过（大小一致）' + stats.skipped + ' 个' +
  '\n           入口：' + join(PROGRAM_RUNTIME, PRODUCT_EXE) +
  '\n           耗时 ' + (Date.now() - t0) + ' ms',
)
