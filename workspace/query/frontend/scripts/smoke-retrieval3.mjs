#!/usr/bin/env node
/**
 * 4.5 两路检索冒烟（npm run smoke:text / smoke:graph / smoke:3way）
 *
 * 判据 ①「两路各自可独立测试」：--only text|graph|all，互不依赖。
 * 🆕 2026-10-19：第三路、软偏置与 `--only bias-ab` 一并下线。
 * 判据 ⑩「性能实测」：每路耗时**实测打印**（不估算）。
 *
 * 用**项目自带 Node 24 原生类型剥离**直跑 .ts（零新依赖、不需要先构建）。
 * 只做两件事：起一次临时 embedding 服务（用完就杀）+ 调三路模块打印结果。
 * **不写任何产物**（除 llama-server 的服务日志，落 data/runtime/logs）。
 *
 * ⚠️ 本脚本是**开发工具**、不是运行时代码：它自己算路径（红线「路径解析只在 launcher/bootstrap」管的是 app 模块）。
 *    真正的编排在 qa-core/index.ts（本脚本不 import 它：qa-core 是 bundle 形态，含 extensionless import）。
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const QUERY = path.join(HERE, '..', '..')
const PROJECT = path.join(QUERY, '..', '..')
const ENV = path.join(PROJECT, 'workspace', 'environment')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const load = (rel) => import(pathToFileURL(path.join(QUERY, rel)).href)

const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
// 🆕 2026-10-22：--data 允许指向镜像库（默认仍是 workspace/data）
const DATA = path.resolve(arg('--data', path.join(PROJECT, 'workspace', 'data')))
const LOGS = path.join(DATA, 'runtime', 'logs')
const only = arg('--only', 'all')
const question = arg('--question', '发电机不发电，电压上不去是什么原因？')

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(QUERY, 'config', rel), 'utf8'))

function pickBackend() {
  const cuda = path.join(ENV, 'llamacpp', 'cuda', 'llama-server.exe')
  return fs.existsSync(cuda)
    ? { backend: 'cuda', exe: cuda, ngl: 99 }
    : { backend: 'cpu', exe: path.join(ENV, 'llamacpp', 'cpu', 'llama-server.exe'), ngl: 0 }
}
const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => resolve(p))
    })
  })
async function waitHealth(port, sec = 120) {
  const t0 = Date.now()
  while ((Date.now() - t0) / 1000 < sec) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/health')
      if (r.ok) {
        const j = await r.json()
        if (j.status === 'ok') return Math.round(Date.now() - t0)
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(400)
  }
  throw new Error('embedding 服务 ' + sec + 's 内没就绪（端口 ' + port + '）')
}
const tok = (s) => Math.round(String(s).length / 1.6)

const bundle = {
  bundleVersion: '1.0',
  question,
  createdAt: Date.now(),
  status: {},
  text: { evidences: [] },
  graph: { seeds: [], nodes: [], links: [], causalPaths: [], cooccurrencePaths: [], noPath: true },
  diagnostics: { paths: [] },
  citations: [],
  evidenceLevel: 'insufficient',
  highestSimilarity: null,
  notes: [],
}

async function keywordsOnly() {
  const { keywordProbe } = await load('text-retrieval/index.ts')
  const cfg = readJson('retrieval/default.json')
  const db = path.join(DATA, 'vector-index', 'chunk', 'chunk.sqlite')
  console.log('=== 关键词路探针（判据②：发电机 / 励磁回路 / 电压 均须命中；不编码、不开服务）===')
  console.log('分词口径：' + cfg.text.segmenter + ' + 型号正则\n')
  const cases = [
    ['发电机', '发电机有什么故障'],
    ['励磁回路', '励磁回路不正常的排查'],
    ['电压', '电压过低怎么办'],
  ]
  let allHit = true
  for (const [word, q] of cases) {
    const p = keywordProbe(db, q, cfg.text.recallPerChannel)
    const hit = p.ranked.length
    if (hit === 0) allHit = false
    console.log('· 词「' + word + '」 问题「' + q + '」')
    console.log('    分词 = ' + p.terms.join(' / '))
    console.log('    模式 = ' + p.mode + ' ｜ 命中 ' + hit + ' 条 ｜ top3 = ' + p.ranked.slice(0, 3).map((x) => x.id).join(','))
  }
  console.log('')
  console.log('判据② 三个词均命中：' + (allHit ? 'PASS' : 'FAIL'))
  console.log('RESULT ' + (allHit ? 'OK' : 'FAIL'))
  process.exit(allHit ? 0 : 1)
}

async function main() {
  if (only === 'keywords') return keywordsOnly()
  const wantRerank = argv.includes('--rerank')
  const { backend, exe, ngl } = pickBackend()
  const models = readJson('models/default.json')
  const cfg = readJson('retrieval/default.json')
  const evCfg = readJson('evidence/default.json')
  if (!fs.existsSync(exe)) throw new Error('缺 llama-server.exe：' + exe)
  const model = path.join(ENV, 'models', 'embedding', models.embedding.gguf)
  if (!fs.existsSync(model)) throw new Error('缺 embedding 模型：' + model)
  fs.mkdirSync(LOGS, { recursive: true })
  const port = await freePort()
  const logPath = path.join(LOGS, 'smoke-4.5-embed-' + new Date().toISOString().replace(/[:.]/g, '-') + '.log')

  console.log('=== 4.5 三路检索冒烟 ===')
  console.log('node ' + process.version + ' ｜ 后端 ' + backend + ' ｜ --only ' + only)
  console.log('问题：「' + question + '」')
  console.log('配置 retrieval=' + cfg._version + ' / evidence=' + evCfg._version + '（阈值均标「未标定」）')
  console.log('')

  const child = spawn(
    exe,
    ['-m', model, '-c', String(models.embedding.ctx), '-ngl', String(ngl),
      '--embedding', '--pooling', models.embedding.pooling, '--embd-normalize', String(models.embedding.embdNormalize),
      '--host', '127.0.0.1', '--port', String(port), '--log-file', logPath],
    { cwd: path.join(ENV, 'llamacpp'), windowsHide: true, stdio: 'ignore' },
  )
  let rerankPort = 0
  let rerankChild = null
  if (wantRerank) {
    const rp = await freePort()
    const rlog = path.join(LOGS, 'smoke-4.5-rerank-' + new Date().toISOString().replace(/[:.]/g, '-') + '.log')
    rerankChild = spawn(
      exe,
      ['-m', path.join(ENV, 'models', 'reranker', models.reranker.gguf), '-c', String(models.reranker.ctx), '-ngl', String(ngl),
        '--reranking', '--pooling', models.reranker.pooling,
        '-b', String(models.reranker.batchSize ?? 2048), '-ub', String(models.reranker.ubatchSize ?? 2048),
        '--host', '127.0.0.1', '--port', String(rp), '--log-file', rlog],
      { cwd: path.join(ENV, 'llamacpp'), windowsHide: true, stdio: 'ignore' },
    )
    const rms = await waitHealth(rp)
    rerankPort = rp
    console.log('reranker 就绪：端口 ' + rp + '，加载 ' + rms + ' ms（--rerank：显式打开默认关闭的开关）')
    // 🔴 预热（I9「启动就绪后做一次预热调用」）：冷启动首调实测比 13- 的暖值慢 3~4 倍（2013 vs 431 ms），
    //    会白吃共用预算 —— 先打一次热身，再计时（与 13- exp03「预热轮丢弃」同口径）
    const { rerank: rerankWarm } = await load('answer-generation/index.ts')
    const warm = await rerankWarm('预热', ['这是一次预热调用，用于触发服务端 KV 与批处理初始化。'], { port: rp, topN: 1 })
    console.log('reranker 预热完成：返回 ' + warm.length + ' 条')
  }
  const kill = () => {
    try { child.kill() } catch { /* 已退出 */ }
    try { if (rerankChild) rerankChild.kill() } catch { /* 已退出 */ }
  }
  process.on('exit', kill)
  try {
    const loadMs = await waitHealth(port)
    console.log('embedding 就绪：端口 ' + port + '，加载 ' + loadMs + ' ms')
    const { embed } = await load('answer-generation/index.ts')
    const t0 = Date.now()
    const [queryVec] = await embed([question], { port })
    console.log('问题编码：' + queryVec.length + ' 维，' + (Date.now() - t0) + ' ms')
    console.log('')

    const db = (n) => path.join(DATA, 'vector-index', n, n + '.sqlite')

    if (only === 'all' || only === 'text' || only === 'graph') {
      const { retrieveText, retrieveTextWithRerank } = await load('text-retrieval/index.ts')
      const { rerank } = await load('answer-generation/index.ts')
      const { retrieveGraph } = await load('graph-retrieval/index.ts')
      const wantText = only === 'all' || only === 'text'
      const wantGraph = only === 'all' || only === 'graph'
      let textR = null
      let graphR = null
      const jobs = []
      if (wantText) {
        jobs.push(async () => {
          const t = Date.now()
          const args = { chunkDb: db('chunk'), question, queryVec, config: cfg.text }
          const plain = retrieveText(args)
          const r = rerankPort > 0
            ? await retrieveTextWithRerank(args, (q, docs) => rerank(q, docs, { port: rerankPort, topN: docs.length }), Math.max(1, cfg.text.rerankPool ?? 5))
            : plain
          if (rerankPort > 0) {
            console.log('【Reranker】已启用（默认关闭）—— 父段落级打分池 ' + (cfg.text.rerankPool ?? 5) + '，重排 ' + r.reranked + ' 个父段落 / ' + r.rerankMs + ' ms' + (r.rerankFallback ? '（兜底：' + r.rerankError + '）' : ''))
            console.log('  不用 Reranker 的 top3 = ' + plain.subChunkIds.slice(0, 3).join(','))
            console.log('  用   Reranker 的 top3 = ' + r.subChunkIds.slice(0, 3).join(','))
          }
          bundle.text = { evidences: r.evidences }
          bundle.status.text = { state: 'ok', ms: Date.now() - t }
          bundle.highestSimilarity = r.topSimilarity
          textR = r
        })
      }
      if (wantGraph) {
        jobs.push(async () => {
          const t = Date.now()
          // 🆕 打分注入：**两处打分共用一个预算**（14- §3.3 超时账；--rerank 时才给）
          const deadline = Date.now() + (cfg.common.rerankBudgetMs ?? 2500)
          const r = await retrieveGraph({
            graphDb: db('graph'), chunkDb: db('chunk'),
            question, queryVec, config: cfg.graph, diagnostics: cfg.diagnostics,
            rerank: rerankPort > 0
              ? { deadline, fn: (q, docs, timeoutMs) => rerank(q, docs, { port: rerankPort, timeoutMs, topN: docs.length }) }
              : null,
          })
          bundle.graph = { seeds: r.seeds, nodes: r.nodes, links: r.links, causalPaths: r.causalPaths, cooccurrencePaths: r.cooccurrencePaths, noPath: r.noPath }
          bundle.diagnostics = { paths: r.diagnostics }
          bundle.status.graph = { state: 'ok', ms: Date.now() - t }
          graphR = r
        })
      }
      // 🔴 与生产一致：**串行**执行（13- §3.8 定案）。原 Promise.all 会让两路打分在同一服务上排队，
      //    把耗时报成 2287/958 ms 的「假慢」（服务端日志证实是排队，不是计算）。
      for (const job of jobs) await job()

      if (textR) {
        const tr = textR
        console.log('【文本路】' + bundle.status.text.ms + ' ms ｜ 最像子块余弦 ' + tr.topSimilarity.toFixed(4))
        console.log('  分词（语料词表最长匹配 + 型号）：' + tr.debug.terms.join(' / '))
        console.log('  关键词路模式 = ' + tr.debug.keywordMode + ' ｜ 向量 top5 = ' + tr.debug.vectorTop.slice(0, 5).join(','))
        console.log('  命中子块（融合 top5）= ' + tr.subChunkIds.slice(0, 5).join(','))
        for (const e of tr.evidences) {
          // v1.2：证据定位单轨化 —— 只打印块编号（来源定位字段已移除）
          console.log('  · [' + e.kind + '] ' + e.chunkId +
            (e.kind === 'user' ? ' ｜ 用户录入' + (e.title ? ' · ' + e.title : '') : '') +
            ' ｜ ' + e.text.length + ' 字 ｜ 分 ' + e.score.toFixed(5))
          console.log('      ' + e.text.replace(/\s+/g, ' ').slice(0, 70) + '…')
        }
        console.log('')
      }
      if (graphR) {
        const gr = graphR
        console.log('【图路】' + bundle.status.graph.ms + ' ms ｜ 种子 ' + gr.seeds.length + ' ｜ 子图 ' + gr.nodes.length + ' 节点 / ' + gr.links.length + ' 边 ｜ no_path=' + gr.noPath)
        for (const s of gr.seeds.slice(0, 6)) {
          console.log('  种子：' + s.name + '（' + s.type + '）分 ' + s.score.toFixed(5) +
            (s.from.pattern ? ' [型号兜底]' : '') +
            (s.from.semantic !== undefined ? ' sem=' + s.from.semantic.toFixed(3) : '') +
            (s.from.text !== undefined ? ' txt=' + s.from.text.toFixed(4) : ''))
        }
        if (gr.causalPaths[0]) {
          const p = gr.causalPaths[0]
          console.log('  图上通路例（无向）：' + p.nodes.map((n) => n.name).join(' — ') + '（directed=' + p.directed + '，应为 false）')
          console.log('     边证据：' + p.edges.map((e) => e.relation + ':' + (e.evidenceChunkIds[0] ?? '无')).join('，'))
        }
        if (gr.cooccurrencePaths[0]) {
          console.log('  共现关联例：' + gr.cooccurrencePaths[0].nodes.map((n) => n.name).join(' ↔ ') + '（明确非因果）')
        }
        for (const n of gr.rerankNotes || []) console.log('  留痕：' + n)
        console.log('  诊断路径 ' + gr.diagnostics.length + ' 条：')
        for (const p of gr.diagnostics.slice(0, 3)) {
          console.log('    ' + p.rank + '. 分 ' + p.score.toFixed(3) + ' ｜ ' + (p.cause ? p.cause.name + ' →' : '') +
            (p.phenomenon ? ' ' + p.phenomenon.name : '') +
            (p.measures.length ? ' → ' + p.measures.map((m) => m.name).join(' / ') : '') +
            (p.pairMissing ? '  【配对缺失】' : ''))
        }
        console.log('')
      }
    }

    // A8 证据充足度三档（与 qa-core 同口径：尺子 = 文本路最像子块余弦）
    const hs = bundle.highestSimilarity
    bundle.evidenceLevel =
      hs === null ? 'insufficient' : hs >= evCfg.sufficiency.sufficient ? 'sufficient' : hs >= evCfg.sufficiency.partial ? 'partial' : 'insufficient'

    const { assignCitations, buildGroundedMessages } = await load('evidence-prompt/index.ts')
    assignCitations(bundle)
    const prompts = readJson('prompts/default.json')
    const msgs = buildGroundedMessages(bundle, [{ role: 'user', content: question }], { historyTurns: 3, historyCharLimit: 4000 }, prompts, evCfg)
    console.log('【证据包】引用编号 ' + bundle.citations.length + ' 个 ｜ 充足度 ' + bundle.evidenceLevel +
      ' ｜ 最高相似度 ' + (bundle.highestSimilarity === null ? 'null' : bundle.highestSimilarity.toFixed(4)))
    const budget = evCfg.prompt.budgetTokens
    console.log('【六段提示词】system ' + tok(msgs[0].content) + ' token ｜ user ' + tok(msgs[1].content) + ' token ｜ 合计 ' +
      tok(msgs[0].content + msgs[1].content) + ' token（六段预算 ≈ ' +
      (budget.roleRules + budget.textEvidence + budget.entities + (budget.paths ?? 0) + budget.diagnostics) + '，maxTotalTokens=' + (evCfg.prompt.maxTotalTokens ?? 7800) + '）')
    console.log('--- system（前 240 字）---')
    console.log(msgs[0].content.slice(0, 240))
    const sub = msgs[1].content.split('【知识图谱·局部子图】')[1]
    console.log('--- user ④ 段（局部子图）---')
    console.log(sub ? ('【知识图谱·局部子图】' + sub.split('\n【')[0]).slice(0, 400) : '(无)')
    const psec = msgs[1].content.split('【知识图谱·图上通路】')[1]
    console.log('--- user ⑤ 段（图上通路·无向）---')
    console.log(psec ? ('【知识图谱·图上通路】' + psec.split('\n【')[0]).slice(0, 2500) : '(无)')
    console.log('')
    console.log('RESULT OK')
  } finally {
    kill()
    await sleep(300)
  }
}
main().catch((e) => {
  console.error('FAIL ' + (e && e.message ? e.message : String(e)))
  process.exit(1)
})
