#!/usr/bin/env node
/**
 * ours 的无 GUI CLI —— 直接驱动 app 已构建的 qa-core worker（同一份问答链）。
 *
 * 原理：`bin/resources/app/qa-core/index.js` 是 CommonJS 产物，模块顶部有
 *   `if (process.parentPort) startBackendWorker()`
 * 本脚本在 require 之前塞一个假的 `process.parentPort`，并按主进程协议发两条消息：
 *   1) `{kind:'service', services:[embedding/answer/reranker], answer, dial}` 注册服务端口
 *   2) `{kind:'chat', userMessage}` 触发 runChat，答案以 `chat.delta` / `chat.done` 回传
 * 因此 CLI 与 GUI 走的是**同一份编排、同一套检索与 prompt**，不是第二套实现。
 *
 * 用法：
 *   node run_ours.mjs --question "..." --outdir <dir> [--app <appRoot>] [--program <programRoot>]
 *        [--embedding 18081] [--answer 18082] [--reranker 18083] [--timeout 600]
 *
 * 产物（每题一个目录）：
 *   answer.json / evidence.json / subgraph.json / citations.json / answer.md
 */
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EXPERIMENT = path.resolve(HERE, '..', '..', '..', '..')
const PROJECT = path.resolve(EXPERIMENT, '..')
const WORKSPACE = path.join(PROJECT, 'workspace')

const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}

const question = arg('--question')
if (!question) {
  console.error('usage: node run_ours.mjs --question "..." --outdir <dir>')
  process.exit(2)
}
const outdir = path.resolve(arg('--outdir', path.join(EXPERIMENT, 'data_performance', 'answer', 'ours', 'pilot', 'runs', 'adhoc', 'r1')))
// 🆕 2026-10-22：--data 允许指向 data 镜像（默认 workspace/data）
const DATA = path.resolve(arg('--data', path.join(WORKSPACE, 'data')))
const APP = path.resolve(arg('--app', path.join(WORKSPACE, 'bin', 'resources', 'app')))
const PROGRAM = path.resolve(arg('--program', path.join(WORKSPACE, 'query')))
const EMB_PORT = Number(arg('--embedding', '18081'))
const ANS_PORT = Number(arg('--answer', '18082'))
const RANK_PORT = Number(arg('--reranker', '18083'))
const TIMEOUT_MS = Number(arg('--timeout', '150')) * 1000

const RUN = path.resolve(arg('--runtime', path.join(EXPERIMENT, 'data_performance', 'answer', 'ours', 'pilot', '_runtime')))
fs.mkdirSync(outdir, { recursive: true })
fs.mkdirSync(RUN, { recursive: true })

const readJson = (p, dflt = null) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return dflt
  }
}

const models = readJson(path.join(PROGRAM, 'config', 'models', 'default.json'), {}) || {}
const answerCfg = models.answer || {}

const paths = {
  mode: 'development',
  appRoot: APP,
  programRoot: PROGRAM,
  runtimeRoot: path.join(WORKSPACE, 'bin'),
  binRoot: path.join(WORKSPACE, 'bin'),
  configDir: path.join(PROGRAM, 'config'),
  frontendIndex: path.join(PROGRAM, 'frontend', 'index.html'),
  dataDir: DATA,
  environmentDir: path.join(WORKSPACE, 'environment'),
  runtimeDir: RUN,
  logsDir: path.join(RUN, 'logs'),
  llamacppDir: path.join(WORKSPACE, 'environment', 'llamacpp'),
  modelsDir: path.join(WORKSPACE, 'environment', 'models'),
  chromiumDir: path.join(RUN, 'chromium'),
}

// 假 parentPort：qa-core 只用到 postMessage / on('message')
const parent = new EventEmitter()
const inbox = []
parent.postMessage = (msg) => { inbox.push(msg); try { fs.appendFileSync(path.join(outdir, 'raw_stream.jsonl'), JSON.stringify(msg) + '\n') } catch {}; onStream(msg) }
process.parentPort = parent
process.argv[2] = JSON.stringify(paths)

const requireCjs = createRequire(import.meta.url)
const startedAt = Date.now()
let qa
try {
  qa = requireCjs(path.join(APP, 'qa-core', 'index.js'))
} catch (err) {
  console.error('[cli] 加载 qa-core 失败：' + err.message)
  process.exit(3)
}

const svcMsg = {
  kind: 'service',
  status: { role: 'answer', state: 'ready', port: ANS_PORT },
  services: [
    { role: 'embedding', state: 'ready', port: EMB_PORT },
    { role: 'answer', state: 'ready', port: ANS_PORT },
    { role: 'reranker', state: 'ready', port: RANK_PORT },
  ],
  answer: answerCfg,
  dial: {
    dial: 'cuda',
    forced: false,
    backend: 'cuda',
    rerankerEnabled: true,
    threads: null,
    model: answerCfg.gguf || 'qwen3.0.6B-Q8_0.gguf',
  },
}
parent.emit('message', { data: svcMsg })

const renderer = null

const sessionId = `cli-${Date.now()}`
const msgId = `cli-a-${Date.now()}`
const deltas = []
let evidence = null
let error = null
let done = false

function onStream(data) {
  if (!data) return
  if (data.kind === 'chat.delta') deltas.push(data.text || '')
  else if (data.kind === 'chat.done') {
    evidence = data.evidence
    done = true
  } else if (data.kind === 'chat.error') {
    error = data.error
    done = true
  }
}

const chatReq = {
  id: 1,
  kind: 'chat',
  sessionId,
  assistantMessageId: msgId,
  userMessage: { id: `cli-u-${Date.now()}`, content: question, createdAt: Date.now() },
}
parent.emit('message', { data: chatReq })

const deadline = Date.now() + TIMEOUT_MS
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
while (!done && Date.now() < deadline) await sleep(100)

const answer = deltas.join('')
const timings = { total_ms: Date.now() - startedAt }
const status = error ? { status: 'error', error } : done ? { status: 'completed', error: null } : { status: 'timeout', error: 'cli timeout' }

fs.writeFileSync(path.join(outdir, 'answer.json'), JSON.stringify({ answer, model: 'qwen3-0.6b', endpoint: `http://127.0.0.1:${ANS_PORT}/v1`, chars: answer.length, ...status }, null, 2), 'utf8')
fs.writeFileSync(path.join(outdir, 'timings.json'), JSON.stringify(timings, null, 2), 'utf8')
if (evidence) {
  fs.writeFileSync(path.join(outdir, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8')
  fs.writeFileSync(path.join(outdir, 'subgraph.json'), JSON.stringify({ question, bundleVersion: evidence.bundleVersion, graph: evidence.graph, route: evidence.route, diagnostics: evidence.diagnostics, notes: evidence.notes }, null, 2), 'utf8')
  fs.writeFileSync(path.join(outdir, 'citations.json'), JSON.stringify(evidence.citations, null, 2), 'utf8')
}

// 人读版
const md = []
md.push(`# ${question}\n`)
md.push(`> system=ours · ${status.status} · ${timings.total_ms} ms · bundle=${evidence ? evidence.bundleVersion : 'n/a'}\n`)
md.push('## 回答\n')
md.push(answer || '（空）')
if (evidence) {
  md.push('\n## 文本证据\n')
  for (const e of (evidence.text && evidence.text.evidences) || []) {
    md.push(`- [${e.chunkId}] ${String(e.text).slice(0, 120)}…`)
  }
  md.push('\n## 子图\n')
  md.push(`- seeds: ${(evidence.graph.seeds || []).map((s) => s.name).join('、') || '—'}`)
  md.push(`- nodes=${(evidence.graph.nodes || []).length} · links=${(evidence.graph.links || []).length} · 因果通路=${(evidence.graph.causalPaths || []).length} · 共现通路=${(evidence.graph.cooccurrencePaths || []).length}`)
  md.push(`- 无路径标记: ${evidence.graph.noPath}`)
  md.push('\n## 诊断路径\n')
  for (const d of (evidence.diagnostics && evidence.diagnostics.paths) || []) {
    md.push(`- ${d.cause ? d.cause.name : '—'} → ${(d.measures || []).map((m) => m.name).join('；') || '—'}`)
  }
  md.push('\n## 备注\n')
  for (const n of evidence.notes || []) md.push(`- ${n}`)
}
fs.writeFileSync(path.join(outdir, 'answer.md'), md.join('\n') + '\n', 'utf8')

console.log(JSON.stringify({ status: status.status, chars: answer.length, ms: timings.total_ms, evidence: Boolean(evidence), outdir }, null, 2))
process.exit(status.status === 'completed' ? 0 : 1)
