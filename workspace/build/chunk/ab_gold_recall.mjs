#!/usr/bin/env node
/**
 * A/B：同一批题，对比两套库的 gold 召回。
 * 用法：node ab_gold_recall.mjs --a <dataA> --b <dataB> --questions <json> [--port 18401] [--limit 50]
 * 指标：gold 点被"返回的父块文本"覆盖的比例；证据平均字数；平均耗时。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJECT = path.resolve(HERE, '..', '..', '..')
const QUERY = path.join(PROJECT, 'workspace', 'query')
const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const A = path.resolve(arg('--a')), B = path.resolve(arg('--b'))
const QF = path.resolve(arg('--questions'))
const PORT = Number(arg('--port', '18401'))
const LIMIT = Number(arg('--limit', '50'))
const cfg = JSON.parse(fs.readFileSync(path.join(QUERY, 'config', 'retrieval', 'default.json'), 'utf8'))
const { retrieveText } = await import(pathToFileURL(path.join(QUERY, 'text-retrieval', 'index.ts')).href)

const norm = (s) => String(s || '').replace(/\s+/g, '')
const qs = JSON.parse(fs.readFileSync(QF, 'utf8')).questions.slice(0, LIMIT)

async function embed(text) {
  const r = await fetch('http://127.0.0.1:' + PORT + '/v1/embeddings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: [text], encoding_format: 'float' }),
  })
  const j = await r.json()
  return j.data[0].embedding
}

async function run(dataDir) {
  const db = path.join(dataDir, 'vector-index', 'chunk', 'chunk.sqlite')
  let covered = 0, points = 0, chars = 0, ev = 0, ms = 0, spanMiss = 0
  for (const q of qs) {
    const vec = await embed(q.question)
    const t0 = Date.now()
    const r = retrieveText({ chunkDb: db, question: q.question, queryVec: vec, config: cfg.text })
    ms += Date.now() - t0
    const texts = r.evidences.map((e) => norm(e.text)).join('\u0001')
    for (const kp of q.key_points || []) {
      points++
      if (texts.includes(norm(kp.quote))) covered++
    }
    chars += r.evidences.reduce((s, e) => s + e.text.length, 0)
    ev += r.evidences.length
  }
  return { covered, points, recall: +(covered / points * 100).toFixed(2), avgEv: +(ev / qs.length).toFixed(2), avgChars: Math.round(chars / qs.length), avgMs: Math.round(ms / qs.length) }
}

console.log('A =', A, '\nB =', B)
const ra = await run(A)
const rb = await run(B)
console.log('A(基线):', JSON.stringify(ra))
console.log('B(候选):', JSON.stringify(rb))
console.log('delta recall =', (rb.recall - ra.recall).toFixed(2), 'pt')
