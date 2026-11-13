#!/usr/bin/env node
/**
 * 检索模型冒烟（目标 2.5 · 步骤 2.5.4；`npm run smoke:retrieval`）
 *
 * 一条命令做四件事：
 *   ① 起 Embedding + Reranker 两个 llama-server（用**构建产物**里的 config/models，gguf 名与 ctx 都从配置读）
 *      —— **honoring `enabled`**：某个服务被关掉（enabled=false）就不起它，并**打印原因**（不静默跳过）
 *   ② **三类对象各向量化一次**（文本块正文 / 实体名 / 三元组句）——打印维度、模长
 *   ③ 确定性：预热后两次同文本 → 逐位比较 + 余弦（口径见施工单 §4.3）
 *   ④ 一次 rerank（1 相关 + 2 无关）→ 打印排序结论；证据落 交接文档/验收记录/目标2.5/05-smoke.json
 *
 * 依赖 **answer-generation/index.js 的薄封装**（embed / rerank）—— 冒烟同时验证封装本身。
 * 只读：除 05-smoke.json 与 data/runtime/logs 下的服务日志外不改任何东西；结束时终止自己起的进程。
 */
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { spawn } = require('node:child_process')

const HERE = __dirname
const FRONTEND = path.join(HERE, '..')
const QUERY = path.join(FRONTEND, '..')
const PROJECT = path.join(QUERY, '..', '..')
const APP = path.join(PROJECT, 'workspace', 'bin', 'resources', 'app')
const ENV = path.join(PROJECT, 'workspace', 'environment')
const LOGS = path.join(PROJECT, 'workspace', 'data', 'runtime', 'logs')
const EVID = path.join(PROJECT, '交接文档', '验收记录', '目标2.5')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function readConfig() {
  const built = path.join(APP, 'config', 'models', 'default.json')
  const src = path.join(QUERY, 'config', 'models', 'default.json')
  const file = fs.existsSync(built) ? built : src
  return { file, cfg: JSON.parse(fs.readFileSync(file, 'utf8')) }
}

function pickBackend(cfg) {
  const cuda = path.join(ENV, 'llamacpp', 'cuda', 'llama-server.exe')
  const cpu = path.join(ENV, 'llamacpp', 'cpu', 'llama-server.exe')
  if (fs.existsSync(cuda)) return { backend: 'cuda', exe: cuda, ngl: cfg.answer.nglGpu }
  return { backend: 'cpu', exe: cpu, ngl: cfg.answer.ngl }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)) })
  })
}

async function waitHealth(port, sec = 90) {
  const t0 = Date.now()
  while ((Date.now() - t0) / 1000 < sec) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/health')
      if (r.ok) { const j = await r.json(); if (j.status === 'ok') return Math.round(Date.now() - t0) }
    } catch { /* 还没起来 */ }
    await sleep(400)
  }
  throw new Error('服务在 ' + sec + 's 内没就绪：端口 ' + port)
}

const norm = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0))
const cosine = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] } return d / (Math.sqrt(na) * Math.sqrt(nb)) }
const maxAbsDiff = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) { const t = Math.abs(a[i] - b[i]); if (t > m) m = t } return m }

async function main() {
  const t0 = Date.now()
  const { file: cfgFile, cfg } = readConfig()
  const be = pickBackend(cfg)
  if (!fs.existsSync(be.exe)) throw new Error('缺 llama-server.exe：' + be.exe)
  fs.mkdirSync(LOGS, { recursive: true })
  const children = []
  const skipped = { embedding: cfg.embedding.enabled !== true, reranker: cfg.reranker.enabled !== true }
  try {
    const embModel = path.join(ENV, 'models', 'embedding', cfg.embedding.gguf)
    const rerModel = path.join(ENV, 'models', 'reranker', cfg.reranker.gguf)
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    let embPort = null, rerPort = null, embMs = null, rerMs = null

    // ------- ① 起服务（尊重 enabled） -------
    if (skipped.embedding) {
      console.log('[smoke] 跳过 embedding：config/models 里 embedding.enabled=false（不启动该服务）')
    } else {
      if (!fs.existsSync(embModel)) throw new Error('缺模型文件：' + embModel)
      embPort = await freePort()
      const embLog = path.join(LOGS, 'smoke-embedding-' + ts + '.log')
      const embArgs = ['-m', embModel, '-c', String(cfg.embedding.ctx), '-ngl', String(be.ngl), '--embedding', '--pooling', cfg.embedding.pooling, '--embd-normalize', String(cfg.embedding.embdNormalize), '--host', '127.0.0.1', '--port', String(embPort), '--log-file', embLog]
      children.push(spawn(be.exe, embArgs, { cwd: path.dirname(be.exe), windowsHide: true, stdio: 'ignore' }))
      embMs = await waitHealth(embPort)
      console.log('[smoke] embedding 就绪 ' + embMs + ' ms（端口 ' + embPort + '，后端 ' + be.backend + '，-ngl ' + be.ngl + '）')
    }
    if (skipped.reranker) {
      console.log('[smoke] 跳过 reranker：config/models 里 reranker.enabled=false（不启动该服务，因此也不做重排打分）')
    } else {
      if (!fs.existsSync(rerModel)) throw new Error('缺模型文件：' + rerModel)
      rerPort = await freePort()
      const rerLog = path.join(LOGS, 'smoke-reranker-' + ts + '.log')
      const rerArgs = ['-m', rerModel, '-c', String(cfg.reranker.ctx), '-ngl', String(be.ngl), '--reranking', '--pooling', cfg.reranker.pooling, '--host', '127.0.0.1', '--port', String(rerPort), '--log-file', rerLog]
      children.push(spawn(be.exe, rerArgs, { cwd: path.dirname(be.exe), windowsHide: true, stdio: 'ignore' }))
      rerMs = await waitHealth(rerPort)
      console.log('[smoke] reranker 就绪 ' + rerMs + ' ms（端口 ' + rerPort + '）')
    }

    const wrapper = require(path.join(APP, 'answer-generation', 'index.js'))
    const { embed, rerank } = wrapper
    if (typeof embed !== 'function' || typeof rerank !== 'function') throw new Error('answer-generation 没有导出 embed / rerank')

    // ------- ② 三类对象各向量化一次 -------
    const chunkText = '发电机电压低于额定值的常见原因包括励磁回路故障、调压器失灵与碳刷接触不良，应逐项检查并测量励磁电流。'
    const entityName = '励磁回路'
    const tripleText = '故障原因 → 导致 → 故障现象：励磁回路故障 导致 发电机电压过低'
    const objects = [chunkText, entityName, tripleText]
    let dims = null, norms = null, cos = null, diff = null, crossCos = null
    if (!skipped.embedding) {
      const vecs = await embed(objects, { port: embPort })
      dims = vecs.map((v) => v.length)
      norms = vecs.map((v) => Number(norm(v).toFixed(6)))
      console.log('[smoke] 三类对象：维度 ' + dims.join('/') + '；模长 ' + norms.join('/'))
      // ③ 确定性（预热后两次同文本）
      await embed([chunkText], { port: embPort })
      const a = (await embed([chunkText], { port: embPort }))[0]
      const b = (await embed([chunkText], { port: embPort }))[0]
      cos = Number(cosine(a, b).toFixed(8))
      diff = maxAbsDiff(a, b)
      console.log('[smoke] 确定性：预热后两次 余弦 ' + cos + '，逐元素最大差 ' + diff.toExponential(3) + (diff === 0 ? '（逐位一致）' : ''))
      const other = (await embed(['船用柴油机的燃油滤器需要定期更换'], { port: embPort }))[0]
      crossCos = Number(cosine(vecs[0], other).toFixed(4))
      console.log('[smoke] 区分度：相关句 vs 无关句 余弦 ' + crossCos)
    }

    // ------- ④ 一次 rerank -------
    const query = '发电机电压过低是什么原因'
    const docs = [chunkText, '船用柴油机的燃油系统需要定期检查滤器并排放水分。', '甲板起重机的液压油应每季度更换一次并检查油位。']
    let ranked = null, order = null, relevantTop = null
    if (!skipped.reranker) {
      ranked = await rerank(query, docs, { port: rerPort })
      const byScore = [...ranked].sort((x, y) => y.score - x.score)
      order = byScore.map((r) => r.index)
      relevantTop = order[0] === 0
      console.log('[smoke] rerank 原始分数：' + ranked.map((r) => r.index + '=' + r.score.toFixed(6)).join('  '))
      console.log('[smoke] rerank 排序（高→低）：' + order.map((i) => 'doc' + i).join(' > '))
    }

    const embedOk = skipped.embedding || (dims && dims.every((d) => d === 1024) && diff === 0)
    const rerankOk = skipped.reranker || relevantTop === true
    fs.mkdirSync(EVID, { recursive: true })
    const evidence = {
      at: new Date().toISOString(),
      backend: be.backend,
      ngl: be.ngl,
      configFile: cfgFile,
      skipped: skipped,
      services: {
        embedding: skipped.embedding ? 'skipped（enabled=false）' : { port: embPort, readyMs: embMs },
        reranker: skipped.reranker ? 'skipped（enabled=false）' : { port: rerPort, readyMs: rerMs },
      },
      embed: skipped.embedding ? 'skipped' : { objects: ['chunk', 'entity', 'triple'], dims: dims, norms: norms },
      determinism: skipped.embedding ? 'skipped' : { cosine: cos, maxAbsDiff: diff, bitExact: diff === 0 },
      discrimination: skipped.embedding ? 'skipped' : { relatedVsUnrelatedCos: crossCos },
      rerank: skipped.reranker ? 'skipped（enabled=false）' : { query: query, documents: docs, raw: ranked, order: order, relevantTop: relevantTop },
      elapsedMs: Date.now() - t0,
      pass: Boolean(embedOk && rerankOk),
    }
    const out = path.join(EVID, '05-smoke.json')
    fs.writeFileSync(out, JSON.stringify(evidence, null, 2))
    console.log('[smoke] 证据 → ' + out)
    console.log('[smoke] 结论：' + (embedOk && rerankOk ? '✅ 通过' : '❌ 不通过') + (skipped.embedding || skipped.reranker ? '（含被跳过的服务，见上面原因）' : ''))
    if (!(embedOk && rerankOk)) process.exitCode = 1
  } finally {
    for (const c of children) { try { c.kill() } catch { /* 已退出 */ } }
    for (let i = 0; i < 16; i++) {
      if (children.every((c) => c.exitCode !== null || c.signalCode !== null)) break
      await sleep(500)
    }
    const alive = children.filter((c) => c.exitCode === null && c.signalCode === null).length
    console.log('[smoke] 收尾：自己起的 ' + children.length + ' 个服务已退出 ' + (children.length - alive) + ' 个' + (alive ? '（⚠️ 仍有 ' + alive + ' 个未退出）' : '（残留 0）'))
    if (alive > 0) process.exitCode = 1
  }
}

main().catch((err) => { console.error('[smoke] ❌ ' + (err && err.message ? err.message : String(err))); process.exitCode = 1 })
