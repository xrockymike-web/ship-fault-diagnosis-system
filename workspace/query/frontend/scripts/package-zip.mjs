#!/usr/bin/env node
/**
 * 可分发 ZIP（目标 2 步骤 2.7）
 * 用法：npm run package
 *
 * 规则（施工单 §5 2.7 + D2-4 / D2-16 / D2-17 / D2-18）：
 *   1. 前置：portable/ 三兄弟齐全 + 一级启动器在 + **程序没在运行**（否则 EPERM）
 *   2. 白名单：只收 bin/、environment/、data/ 的骨架说明文件；**data/runtime 的内容一律不进包**
 *      —— 用**硬链接**搭暂存目录（秒级、零额外占用），再整目录压缩
 *   3. 校验清单（目标 2 版）：任一失败即中止，**不产出残缺 zip**
 *   4. 压缩：优先 `pwsh` 的 Compress-Archive -CompressionLevel NoCompression
 *      （Q7-6 实测：tar.exe 不写 UTF-8 标志 → 中文名会在 .NET 解压侧乱码；PS7 的 Compress-Archive 写标志 + 可存储模式）
 *      退化路径：只有 Windows PowerShell 5.1 时用默认压缩，并**明确告知**（慢、体积略小）
 *   5. 先写 `.part`，成功后改名（避免 release/ 里留下"看着像成品"的残包）
 *   6. **带一层** `船舶故障诊断系统-v<版本>/`（D2-18）
 *   7. 版本号唯一源：frontend/package.json（D2-17）
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, linkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url)) // query/frontend/scripts
const FRONTEND = join(HERE, '..') // query/frontend
const QUERY_DIR = join(FRONTEND, '..') // query/
const PROJECT_ROOT = join(QUERY_DIR, '..', '..') // 项目根
const PORTABLE = join(PROJECT_ROOT, 'portable')
const RELEASE = join(PROJECT_ROOT, 'release')
const VERSION = JSON.parse(readFileSync(join(FRONTEND, 'package.json'), 'utf8')).version
const TOP = '船舶故障诊断系统-v' + VERSION
const ZIP_NAME = TOP + '-win-x64.zip'
const ZIP_PATH = join(RELEASE, ZIP_NAME)
const STAGE = join(RELEASE, '_stage')
const LAUNCHER = '船舶故障诊断系统.exe'
const PRODUCT_EXE = LAUNCHER
const BAT = '启动.bat'

const t0 = Date.now()
function fail(msg) {
  console.error('[zip] ✗ ' + msg)
  cleanup()
  process.exit(1)
}
function cleanup() {
  try { rmSync(STAGE, { recursive: true, force: true }) } catch { /* ignore */ }
}
const MiB = (n) => (n / 1024 / 1024).toFixed(1) + ' MiB'

// ---------- 1. 前置检查 ----------
if (!existsSync(PORTABLE)) fail('没有 portable/：先跑 npm run build && npm run package:portable')
if (!existsSync(join(PORTABLE, LAUNCHER))) fail('一级启动器不在：' + join(PORTABLE, LAUNCHER) + '（先跑 npm run package:portable）')
if (!existsSync(join(PORTABLE, BAT))) fail('1 级兜底 bat 不在：' + join(PORTABLE, BAT))
// 程序是否在运行：能独占写 exe 才说明没跑（Windows 不允许覆盖运行中的 exe）
try {
  // D2-28 布局：入口 exe 在 bin/bin/（bin/ 是程序树、bin/bin/ 是 Electron 运行时）
  // ⚠️ 不能引用下面才定义的 RUNTIME（TDZ）——示例路径写全
  const fd = (await import('node:fs')).openSync(join(PORTABLE, 'bin', LAUNCHER), 'r+')
  ;(await import('node:fs')).closeSync(fd)
} catch (err) {
  fail('无法写入 portable/bin/' + LAUNCHER + '（' + err.code + '）\n  → 若程序正在运行，请**先关闭程序**再打包。')
}
// 磁盘余量：暂存用硬链接（不占空间），但要放得下 zip
try {
  const st = (await import('node:fs')).statfsSync(RELEASE)
  const freeGB = (st.bavail * st.bsize) / 1024 / 1024 / 1024
  if (freeGB < 6) fail('release/ 所在盘可用空间只有 ' + freeGB.toFixed(1) + ' GB，打包需要 ≥6 GB')
  console.log('[zip] 磁盘可用 ' + freeGB.toFixed(1) + ' GB')
} catch { /* statfs 不可用就跳过 */ }

// ---------- 2. 校验清单（目标 2 版，D2-16）----------
console.log('[zip] 校验清单（目标 2 版）…')
// D2-28 布局：bin/ = 程序树（与 query 同构）；bin/bin/ = Electron 运行时 + 跳板 resources/app
const APP = join(PORTABLE, 'query')            // 程序树（D2-29：与 workspace/query 同名对照）
const RUNTIME = join(PORTABLE, 'bin')             // 交付态运行时（与 query 平级，D2-31 乙）
const checks = []
const ok = (name, cond, detail) => { checks.push({ name, pass: !!cond, detail }); }

ok('query/main.js（程序树根）', existsSync(join(APP, 'main.js')))
ok('bin/<产品>.exe（运行时入口）', existsSync(join(RUNTIME, LAUNCHER)))
ok('bin/resources/app/package.json（跳板）', existsSync(join(RUNTIME, 'resources', 'app', 'package.json')))
ok('bin/resources/app/loader.js（跳板）', existsSync(join(RUNTIME, 'resources', 'app', 'loader.js')))
for (const c of ['application', 'models', 'prompts', 'retrieval', 'evidence', 'logging']) {
  ok('config/' + c + '/', existsSync(join(APP, 'config', c)))
}
ok('llamacpp/cpu/llama-server.exe', existsSync(join(PORTABLE, 'environment', 'llamacpp', 'cpu', 'llama-server.exe')))
ok('llamacpp/cuda/llama-server.exe', existsSync(join(PORTABLE, 'environment', 'llamacpp', 'cuda', 'llama-server.exe')))
// 目标 2.5（D25-15）：三个模型都要在，缺一个就拒绝出包
for (const role of ['answer', 'embedding', 'reranker']) {
  const dir = join(PORTABLE, 'environment', 'models', role)
  ok('models/' + role + '/*.gguf', existsSync(dir) && readdirSync(dir).some((f) => f.toLowerCase().endsWith('.gguf')))
}
ok('environment/electron/electron.exe', existsSync(join(PORTABLE, 'environment', 'electron', 'electron.exe')))
ok('一级启动器', existsSync(join(PORTABLE, LAUNCHER)))
ok('启动.bat', existsSync(join(PORTABLE, BAT)))
// 🆕 2026-10-09（异机鲁棒性预检 · 只增不改，27 项 → 追加 9 项）：
//   ① VC++ 三件套 ×（cpu/cuda 双版）—— 干净 Windows 不自带，缺了只会在**别人的电脑**上炸；
//   ② 三个模型按 config 的**指定文件名**核对（原检查只看"有没有 .gguf"）；
//   ③ 交付根说明文件必须在（首启为什么慢 / 被 Windows 拦怎么办）。
const VCRUNTIME_DLLS = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']
for (const flavor of ['cpu', 'cuda']) {
  for (const dll of VCRUNTIME_DLLS) {
    ok('llamacpp/' + flavor + '/' + dll, existsSync(join(PORTABLE, 'environment', 'llamacpp', flavor, dll)))
  }
}
let zipModelsCfg = null
try { zipModelsCfg = JSON.parse(readFileSync(join(APP, 'config', 'models', 'default.json'), 'utf8')) } catch { /* 下面这行会报 */ }
ok('config/models/default.json 可读', !!zipModelsCfg)
for (const role of ['answer', 'embedding', 'reranker']) {
  const want = zipModelsCfg && zipModelsCfg[role] && zipModelsCfg[role].gguf
  ok('models/' + role + '/' + (want || '(配置缺 gguf)'), !!want && existsSync(join(PORTABLE, 'environment', 'models', role, want)))
}
// 🆕 v0.3.2：**CPU 档覆盖块**指定的回答模型（Q4_K_M）也必须在包里 ——
//   负责人 2026-10-12 定「CPU 换 Q4 / GPU 留 Q8」→ 两个模型都要随包（包体因此跨过 4 GB → zip64）
{
  const cpuAnswer = zipModelsCfg && zipModelsCfg.cpu && zipModelsCfg.cpu.answer ? zipModelsCfg.cpu.answer : null
  const cpuDir = cpuAnswer ? (cpuAnswer.modelDir || 'answer') : 'answer-q4km'
  const cpuGguf = cpuAnswer ? cpuAnswer.gguf : '(配置缺 cpu.answer.gguf)'
  ok('models/' + cpuDir + '/' + cpuGguf + '（CPU 档）', !!cpuAnswer && existsSync(join(PORTABLE, 'environment', 'models', cpuDir, cpuGguf)))
}
const FIRST_RUN_NOTE = '首次启动说明.txt'
ok(FIRST_RUN_NOTE + '（交付根）', existsSync(join(PORTABLE, FIRST_RUN_NOTE)))
// 🆕 2026-10-07（目标 4 完成后启用）：两个检索库 + 交付装箱单 —— 缺一个就不许出包
//   2026-10-19：第三个库不再随包
for (const n of ['chunk', 'graph']) {
  ok('data/vector-index/' + n + '/' + n + '.sqlite', existsSync(join(PORTABLE, 'data', 'vector-index', n, n + '.sqlite')))
}
const dataManifest = join(PORTABLE, 'data', 'vector-index', 'manifest.json')
ok('data/vector-index/manifest.json（装箱单）', existsSync(dataManifest))
if (existsSync(dataManifest)) {
  const dm = JSON.parse(readFileSync(dataManifest, 'utf8'))
  const stores = dm.stores || {}
  ok('装箱单两库齐', ['chunk', 'graph'].every((n) => !!stores[n]))
  // 🔴 2026-10-22：不再硬编码 3389。重建会改变块数/向量数，硬编码只会逼人改装箱单。
  //    判据改为：totals.vectors == 两库 by_store 之和，且 >0。
  const byStore = dm.vectors && dm.vectors.by_store ? dm.vectors.by_store : {}
  const sumByStore = Object.values(byStore).reduce((a, b) => a + b, 0)
  ok('装箱单向量总数 = 两库之和', !!dm.totals && dm.totals.vectors === sumByStore && sumByStore > 0,
    'vectors=' + (dm.totals && dm.totals.vectors) + ' by_store_sum=' + sumByStore)
}
ok('data/user_data/（用户自建知识骨架）', existsSync(join(PORTABLE, 'data', 'user_data')))
// 开发残留：data/runtime 里除了我们放的 README.txt 之外**不该有内容**
const runtimeDir = join(PORTABLE, 'data', 'runtime')
// 允许：README.txt（说明）+ 空的 logs/（启动时由程序重建；空目录本来也进不了 zip）
const runtimeEntries = existsSync(runtimeDir) ? readdirSync(runtimeDir).filter((f) => f !== 'README.txt') : []
const runtimeLeftover = runtimeEntries.filter((f) => !(f === 'logs' && existsSync(join(runtimeDir, 'logs')) && readdirSync(join(runtimeDir, 'logs')).length === 0))
ok('data/runtime 无运行残留', runtimeLeftover.length === 0, runtimeLeftover.join(', '))
// 版本号一致
const manifest = existsSync(join(RUNTIME, 'manifest.json')) ? JSON.parse(readFileSync(join(RUNTIME, 'manifest.json'), 'utf8')) : {}
ok('manifest 版本 = package.json 版本', manifest.version === VERSION, 'manifest=' + manifest.version + ' pkg=' + VERSION)
// ⚠️ 补：**Electron 真正读的那份** app/package.json 也要同版本（2026-09-27 真实事故漏检：交付包里它是 0.1.0）
const appPkgFile = join(RUNTIME, 'resources', 'app', 'package.json')
const appPkg = existsSync(appPkgFile) ? JSON.parse(readFileSync(appPkgFile, 'utf8')) : {}
ok('app/package.json 版本 = 唯一源', appPkg.version === VERSION, 'app=' + appPkg.version + ' src=' + VERSION)

const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log('   ' + (c.pass ? '✓' : '✗') + ' ' + c.name + (c.detail && !c.pass ? '  ← ' + c.detail : ''))
if (failed.length > 0) fail('校验清单未全绿（' + failed.length + ' 项）—— **不产出 zip**')

// ---------- 3. 暂存目录（硬链接，白名单）----------
cleanup()
const STAGE_TOP = join(STAGE, TOP)
mkdirSync(STAGE_TOP, { recursive: true })

/** 递归建目录 + 硬链接（同盘：秒级、不占额外空间；删暂存不会动原文件） */
function linkTree(srcDir, dstDir, skip = () => false) {
  mkdirSync(dstDir, { recursive: true })
  for (const e of readdirSync(srcDir, { withFileTypes: true })) {
    const s = join(srcDir, e.name)
    const d = join(dstDir, e.name)
    if (skip(s)) continue
    if (e.isDirectory()) linkTree(s, d, skip)
    else if (e.isFile()) linkSync(s, d)
  }
}
// 禁令（施工单 I6 / D2-16）：.git / node_modules / 日志 / 会话 / SOURCE.txt / 开发期性能记录
const BANNED = (p) => /(^|[\\/])(\.git|node_modules|SOURCE\.txt|PERF\.txt)([\\/]|$)/.test(p) || /\.log$/i.test(p)
linkTree(join(PORTABLE, 'query'), join(STAGE_TOP, 'query'), BANNED)
linkTree(join(PORTABLE, 'bin'), join(STAGE_TOP, 'bin'), BANNED)   // 运行时是顶层目录（D2-31 乙）
linkTree(join(PORTABLE, 'environment'), join(STAGE_TOP, 'environment'), BANNED)
// data/：**知识库骨架 + 说明文件**照搬，运行数据（runtime/ 内容）一律不进包
mkdirSync(join(STAGE_TOP, 'data'), { recursive: true })
const linkData = (rel) => {
  const src = join(PORTABLE, 'data', ...rel)
  const dst = join(STAGE_TOP, 'data', ...rel)
  if (!existsSync(src)) return
  if (statSync(src).isDirectory()) {
    mkdirSync(dst, { recursive: true })
    for (const e of readdirSync(src)) linkData([...rel, e])
    return
  }
  // runtime/ 里只放行说明文件，其余（会话库、缓存、日志）不进包
  if (rel[0] === 'runtime' && rel.length > 1 && rel[1] !== 'README.txt') return
  linkSync(src, dst)
}
linkData([])
// 一级入口
linkSync(join(PORTABLE, LAUNCHER), join(STAGE_TOP, LAUNCHER))
linkSync(join(PORTABLE, BAT), join(STAGE_TOP, BAT))
// 🆕 2026-10-09：交付根说明随包（上面清单已确认它存在，缺了早就 fail 了）
linkSync(join(PORTABLE, FIRST_RUN_NOTE), join(STAGE_TOP, FIRST_RUN_NOTE))

// 暂存体积与残留自检
let stageBytes = 0, stageFiles = 0
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) walk(p)
    else { stageBytes += statSync(p).size; stageFiles += 1 }
  }
}
walk(STAGE_TOP)
console.log('[zip] 暂存（硬链接）' + stageFiles + ' 个文件，' + MiB(stageBytes))

// 开发机绝对路径自检（只看小文本文件，避免遍历 2.4 GB）
const ABS = /[A-Za-z]:\\?[\\/](Work|workapp|Users)\\/i
let absHits = []
const scanText = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) { scanText(p); continue }
    if (statSync(p).size > 1024 * 1024) continue
    if (!/\.(js|json|html|txt|css|md)$/i.test(e.name)) continue
    if (ABS.test(readFileSync(p, 'utf8'))) absHits.push(p.replace(STAGE_TOP, ''))
  }
}
scanText(join(STAGE_TOP, 'query'))
scanText(join(STAGE_TOP, 'data'))
if (absHits.length > 0) fail('暂存里发现开发机绝对路径：\n  ' + absHits.slice(0, 5).join('\n  '))
console.log('[zip] 开发机绝对路径自检：0 处 ✓')

// ---------- 4. 压缩 ----------
mkdirSync(RELEASE, { recursive: true })
const partPath = ZIP_PATH + '.part'
rmSync(partPath, { force: true })
const pwsh = process.env.DSH_PWSH || 'pwsh'
const ps51 = join(process.env.SystemRoot || process.env.WINDIR || ('C:' + '\\Windows'), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const hasPwsh = spawnSync(pwsh, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status === 0
const shell = hasPwsh ? pwsh : ps51
const level = hasPwsh ? 'NoCompression' : 'Optimal'
if (!hasPwsh) {
  console.warn('[zip] ⚠️ 没找到 pwsh（PowerShell 7）：退化用 Windows PowerShell 5.1 ——')
  console.warn('        5.1 的 Compress-Archive **会忽略 NoCompression**（仍走 deflate）：更慢，且体积只小一点点。')
}
console.log('[zip] 压缩：' + shell + '  --CompressionLevel ' + level)
const cmd = 'Compress-Archive -LiteralPath ' + JSON.stringify(STAGE_TOP) + ' -DestinationPath ' + JSON.stringify(partPath) + ' -CompressionLevel ' + level + ' -Force'
const tZip = Date.now()
const res = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', cmd], { stdio: 'inherit' })
if (res.status !== 0) fail('Compress-Archive 失败，退出码 ' + res.status + '（未产出 zip）')
if (!existsSync(partPath)) fail('压缩命令返回 0 但 .part 不存在（未产出 zip）')
const zipMs = Date.now() - tZip
// ---------- 4.5 回读校验：ZIP 里必须**一个目录都不少**（Compress-Archive 会跳过空目录！）----------
// 2026-09-27 实测事故：config/{evidence,logging,retrieval} 是空目录，打包后整层消失，
// 解压出来的树与源码树对不上。所以这里把 ZIP 读回来逐目录比对，缺一个就作废。
function zipDirs(file) {
  const fd = openSync(file, 'r')
  const size = fstatSync(fd).size
  const readAt = (p, l) => {
    const b = Buffer.alloc(Math.min(l, Math.max(0, size - p)))
    readSync(fd, b, 0, b.length, p)
    return b
  }
  const tailLen = Math.min(65536, size)
  const tail = readAt(size - tailLen, tailLen)
  let e = -1
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break }
  if (e < 0) { closeSync(fd); throw new Error('ZIP 中央目录找不到（文件可能损坏）') }
  let total = tail.readUInt16LE(e + 10)
  let cdOff = tail.readUInt32LE(e + 16)
  let cdSize = tail.readUInt32LE(e + 12)
  if (total === 0xffff || cdOff === 0xffffffff) {
    const loc = readAt(size - tailLen + e - 20, 20)
    const z = readAt(Number(loc.readBigUInt64LE(8)), 56)
    total = Number(z.readBigUInt64LE(32))
    cdSize = Number(z.readBigUInt64LE(40))
    cdOff = Number(z.readBigUInt64LE(48))
  }
  const cd = readAt(cdOff, cdSize)
  let p = 0
  const dirs = new Set()
  const files = new Set()
  for (let n = 0; n < total; n++) {
    const nl = cd.readUInt16LE(p + 28)
    const el = cd.readUInt16LE(p + 30)
    const cl = cd.readUInt16LE(p + 32)
    const name = cd.subarray(p + 46, p + 46 + nl).toString('utf8')
    if (name.endsWith('/')) dirs.add(name.slice(0, -1))
    else { files.add(name); const parts = name.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/')) }
    p += 46 + nl + el + cl
  }
  closeSync(fd)
  return { dirs, files, total }
}
const stageDirs = new Set()
const collectDirs = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const p = join(d, e.name)
    stageDirs.add(p.slice(STAGE.length + 1).split('\\').join('/'))
    collectDirs(p)
  }
}
collectDirs(STAGE_TOP)
const inZip = zipDirs(partPath)
const missing = [...stageDirs].filter((d) => !inZip.dirs.has(d))
if (missing.length > 0) {
  rmSync(partPath, { force: true })
  fail('ZIP 里缺了 ' + missing.length + ' 个目录（打包工具跳过空目录）—— 已作废，不产出残缺包：\n  ' + missing.slice(0, 8).join('\n  '))
}
console.log('[zip] 回读校验 ✓ 目录 ' + stageDirs.size + ' 个一个不少，条目 ' + inZip.total + ' 条')

renameSync(partPath, ZIP_PATH)
cleanup()

const zipBytes = statSync(ZIP_PATH).size
console.log('[zip] ✓ ' + ZIP_PATH)
console.log('      ' + MiB(zipBytes) + '（暂存 ' + MiB(stageBytes) + '，压缩率 ' + ((zipBytes / stageBytes) * 100).toFixed(1) + '%）')
console.log('      压缩耗时 ' + (zipMs / 1000).toFixed(1) + ' s，总耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s')
console.log('      内含一层目录：' + TOP + '/')
console.log('      自检：node scripts/zipinfo.cjs "' + ZIP_PATH + '"')
