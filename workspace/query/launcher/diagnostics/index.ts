/**
 * 启动诊断（施工单 §16.5 的"退出码与日志路径写入 diagnostics"）。
 * 目标 1.4 只做**最小实现**：结构化事件追加到 data/runtime/logs/app.log（JSONL）。
 * 崩溃报告、滚动与保留策略留到目标 8（总纲 §7.6）。
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppPaths } from '../bootstrap/index'

export interface DiagEvent {
  /** 事件名，如 model-service:spawn / model-service:exit */
  event: string
  [key: string]: unknown
}

/**
 * 三段冷启动计时（施工单 §18.5）写入 data/runtime/logs/startup.json。
 * t0 进程启动 / t1 窗口出现 / t2 模型就绪；**正式口径 = t2 − t0**。
 */
export interface StartupRecord {
  t0: number
  t1?: number
  t2?: number
  totalMs: number
  mode: string
  appVersion?: string
}

export function writeStartupRecord(paths: AppPaths, record: StartupRecord): void {
  try {
    mkdirSync(paths.logsDir, { recursive: true })
    writeFileSync(join(paths.logsDir, 'startup.json'), JSON.stringify(record, null, 2) + '\n', 'utf8')
  } catch (err) {
    console.warn('[diagnostics] 写 startup.json 失败：', (err as Error).message)
  }
}

/**
 * 🔴 主进程 / utilityProcess 的 **stdout / stderr 的 EPIPE 兜底**（2026-10-06 实测修，见 4.5 补充证据）。
 *
 * **现象**：用「stdout 是管道、且管道会被关掉」的方式启动（脚本化启动、后台任务被回收、父控制台关闭），
 * 之后任意一句 `console.log` 都会抛
 * `Error: EPIPE: broken pipe, write`（实测栈底：`console.log` ← `ModelService.warmup`）。
 * 主进程没人接这个异常 ⇒ Electron 弹「**A JavaScript error occurred in the main process**」对话框，
 * **用户看到的是"程序崩了"** —— 而起因只是一句日志。
 *
 * **处理**：只吞 **EPIPE**（= 日志通道没了，不是业务失败），并**计数 + 记住最后一条**；
 * 其它流错误同样只记不抛。🔴 **不是「全局吞掉 uncaughtException」** —— 真异常必须保持响亮。
 * **不静默**：吞掉的次数由调用方（main 拿到 AppPaths 后）写进 `app.log`（事件 `stdio:epipe`）。
 */
let stdioPipeErrors = 0
let stdioLastError = ''
let stdioGuarded = false

export function guardStdio(): void {
  if (stdioGuarded) return
  stdioGuarded = true
  for (const stream of [process.stdout, process.stderr]) {
    if (!stream || typeof (stream as { on?: unknown }).on !== 'function') continue
    stream.on('error', (err: NodeJS.ErrnoException) => {
      stdioPipeErrors++
      stdioLastError = (err && err.code ? err.code + ': ' : '') + (err && err.message ? err.message : String(err))
    })
  }
}

/** 读被吞掉的 stdio 流错误计数（供 main 写进 app.log；0 = 本进程没遇到） */
export function stdioErrorCount(): { count: number; last: string } {
  return { count: stdioPipeErrors, last: stdioLastError }
}

/** 追加一条结构化事件；失败只告警，**不阻断启动**（诊断本身不该成为新的故障点） */
export function logEvent(paths: AppPaths, ev: DiagEvent): void {
  const line = JSON.stringify({ t: new Date().toISOString(), ...ev }) + '\n'
  try {
    mkdirSync(paths.logsDir, { recursive: true })
    appendFileSync(join(paths.logsDir, 'app.log'), line, 'utf8')
  } catch (err) {
    console.warn('[diagnostics] 写日志失败：', (err as Error).message)
  }
}
