#!/usr/bin/env node
/**
 * 组装脚本 —— 把 Electron 运行时落成**可双击**的 query/bin/bin/（D2-28 统一布局）。
 *
 * 用法：
 *   node scripts/assemble.mjs            只组装（复制运行时 + exe 改名）
 *   node scripts/assemble.mjs --launch   组装后启动组装好的 exe（= 双击等效，供 npm run app）
 *
 * 规则（施工单 §1.1 / §4.4 / §18.2）：
 *   · 运行时**重新取自** workspace/environment/electron/，不从别处搬、不从临时目录搬；
 *   · 增量复制：目标已存在且大小一致则跳过（仍是真实文件，不是链接）；
 *   · 可重复执行：连跑两次结果一致，第二次明显更快；
 *   · 路径全部由本文件位置推导，**不写死任何绝对路径**（红线）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url)) // query/frontend/scripts
const QUERY_DIR = join(HERE, '..', '..') // query/
const PROJECT_ROOT = join(QUERY_DIR, '..', '..') // 项目根
const SRC = join(PROJECT_ROOT, 'workspace', 'environment', 'electron')
const BIN_RUNTIME = join(QUERY_DIR, '..', 'bin')      // workspace/bin = 运行时 + 入口 exe（D2-31 乙）
const PRODUCT_EXE = '船舶故障诊断系统.exe'
const SOURCE_EXE = 'electron.exe'
/** 开发侧的来源/自检记录，不进 bin/ */
const SKIP = new Set(['SOURCE.txt', 'verify-runtime.cjs'])

function fail(msg) {
  console.error('[assemble] ✗ ' + msg)
  process.exit(1)
}

if (!existsSync(join(SRC, SOURCE_EXE))) {
  fail(
    '缺少 Electron 运行时：' + join(SRC, SOURCE_EXE) +
    '\n  请先按 workspace/data/resources.md 把 Electron 解压到 workspace/environment/electron/（本脚本不联网下载）',
  )
}

function copyIncremental(srcDir, dstDir) {
  mkdirSync(dstDir, { recursive: true })
  let copied = 0
  let skipped = 0
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const s = join(srcDir, entry.name)
    const d = join(dstDir, entry.name)
    if (entry.isDirectory()) {
      const r = copyIncremental(s, d)
      copied += r.copied
      skipped += r.skipped
      continue
    }
    // 与 package-portable 同判据：大小相同**且**目标不比源旧，才跳过（只比大小会漏掉同尺寸的内容变化）
    const sd = statSync(s)
    if (existsSync(d) && statSync(d).size === sd.size && statSync(d).mtimeMs >= sd.mtimeMs) {
      skipped += 1
      continue
    }
    copyFileSync(s, d)
    copied += 1
  }
  return { copied, skipped }
}

const t0 = Date.now()
const { copied, skipped } = copyIncremental(SRC, BIN_RUNTIME)

// exe 改名（**不是**再复制一份）：bin 根只该有一个入口 exe。
// 若用复制，electron.exe 会与产品名 exe 同时留下 —— 实测多占 234.6 MiB，
// 且用户可能误双击 electron.exe（§7.4.4 的交付布局里没有它）。
const binOriginalExe = join(BIN_RUNTIME, SOURCE_EXE)
const binProductExe = join(BIN_RUNTIME, PRODUCT_EXE)
try {
  if (existsSync(binOriginalExe)) {
    if (existsSync(binProductExe)) rmSync(binProductExe, { force: true })
    renameSync(binOriginalExe, binProductExe)
  } else if (!existsSync(binProductExe)) {
    copyFileSync(join(SRC, SOURCE_EXE), binProductExe)
  }
} catch (err) {
  // 最常见的失败：程序还开着，exe 被占用（Windows 不允许覆盖正在运行的 exe）。
  // 给一句能照着做的话，而不是把 EPERM 堆栈甩给用户。
  fail(
    '无法写入 ' + binProductExe + '\n' +
    '  原因：' + err.code + '（文件被占用或只读）\n' +
    '  → 若程序正在运行，请**先关闭程序**再重新组装。',
  )
}

// 开发态**不需要跳板**：构建产物本来就落在 <workspace/bin>/resources/app（Electron 认的 app 目录）
// （交付态才需要跳板——那边的程序在 portable/query，见 package-portable.mjs）
const appManifest = join(BIN_RUNTIME, 'resources', 'app', 'package.json')
if (!existsSync(appManifest)) {
  fail('缺少 ' + appManifest + '：请先跑 npm run build（它是三段构建的产物）')
}

console.log(
  '[assemble] ✓ ' + BIN_RUNTIME +
  '\n           复制 ' + copied + ' 个文件，跳过（大小一致）' + skipped + ' 个' +
  '\n           入口：' + join(BIN_RUNTIME, PRODUCT_EXE) +
  '\n           耗时 ' + (Date.now() - t0) + ' ms',
)

if (process.argv.includes('--launch')) {
  console.log('[assemble] 启动 ' + PRODUCT_EXE + '（等价双击）')
  const child = spawnSync(join(BIN_RUNTIME, PRODUCT_EXE), [], { stdio: 'inherit', cwd: BIN_RUNTIME })
  process.exit(child.status ?? 0)
}
