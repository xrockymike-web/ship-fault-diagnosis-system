/**
 * 文本检索（第一路）—— **父子块 + 双路召回 RRF**（《技术总纲》§4.3.1 七步 + 决策 D24 A2/A11）
 *
 * 七步：① 问题原样 embed（**由 qa-core 统一编码一次后注入**，本模块不编码）
 *      ② 向量路 全部子块余弦 → top 30
 *      ③ 关键词路 词级 BM25（chunks_fts）→ top 30
 *      ④ RRF（1/(60+r_vec) + 1/(60+r_kw)，两路等权，缺席记 0；同分向量分高者先）
 *      ⑤ 子块→父块（同父只收一次、凑够 finalK 停）
 *      ⑥ 总量 ≤ 3000 字（超则末条截）
 *      ⑦ 交出 finalK 条父块 + 命中子块（高亮）—— 定位**只用块编号**（v1.2）
 *
 * 三条纪律：
 *   · **只查 chunk 库，只读打开**；路径由调用方注入（红线 R3：路径解析只在 launcher/bootstrap）；
 *   · 本模块**不认识实体**、也不做任何范围放大；
 *   · 出错**指名道姓**，绝不静默降级。
 *
 * 🔴 查询侧分词：运行期零新依赖（Node 无 jieba）→ 用**语料词表最长匹配**
 *    （词表 = \`chunks.text_seg\` 里的 jieba 词，即索引侧同一份词表；型号由正则补），
 *    与 §4.3.1 的「jieba 分词 + 自定义词典」等价到**索引词表层面**。已登记（config/retrieval.text.segmenter）。
 */
import { DatabaseSync } from 'node:sqlite'
// 🔴 带 .ts 后缀：本模块会被 Node 原生类型剥离直跑（smoke-retrieval3 / 实验脚本），
//    扩展名缺省在 Node ESM 下解析不到（qa-core 走 bundle 才允许省略）
import { patternTokens } from '../shared/tokens.ts'
import type { TextEvidence } from '../shared/types'

export interface TextConfig {
  recallPerChannel: number
  finalK: number
  rrfK: number
  charLimit: number
  /** 🆕 13- §3.4：父段落级打分池（5）—— 按融合榜取前 N 个**不同父段落**、每段全文交打分 */
  rerankPool?: number
}

export interface TextRetrievalParams {
  /** chunk.sqlite 绝对路径（由调用方注入） */
  chunkDb: string
  question: string
  /** 问题向量（qa-core 统一编码一次，1024 维） */
  queryVec: number[]
  config: TextConfig
}

export interface Ranked { id: string; score: number }

export interface TextRetrievalResult {
  evidences: TextEvidence[]
  /** 融合后的子块榜（top-N）—— 冒烟与口径核对用 */
  subChunkIds: string[]
  /** **文本路最像子块余弦** —— A8 证据三档的尺子（RRF 分无绝对含义，不能用） */
  topSimilarity: number
  debug: {
    terms: string[]
    vectorTop: string[]
    keywordTop: string[]
    keywordMode: 'fts' | 'like-fallback' | 'none'
    truncated: boolean
    chars: number
  }
}

// ---------------------------------------------------------------------------
// 只读连接 / 向量 / 词表（进程内缓存，够用就好）
// ---------------------------------------------------------------------------

const DBS = new Map<string, DatabaseSync>()
const VEC = new Map<string, { ids: string[]; vecs: Float32Array[]; pos: Map<string, number> }>()
const VOCAB = new Map<string, Set<string>>()

function openRo(path: string): DatabaseSync {
  let db = DBS.get(path)
  if (!db) {
    db = new DatabaseSync(path, { readOnly: true })
    DBS.set(path, db)
  }
  return db
}

function toVec(blob: unknown): Float32Array {
  const b = blob as Uint8Array
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
  return new Float32Array(ab)
}

function chunkVectors(dbPath: string): { ids: string[]; vecs: Float32Array[]; pos: Map<string, number> } {
  const hit = VEC.get(dbPath)
  if (hit) return hit
  const db = openRo(dbPath)
  const ids: string[] = []
  const vecs: Float32Array[] = []
  for (const r of db.prepare('SELECT obj_id, blob FROM vectors').iterate() as Iterable<Record<string, unknown>>) {
    ids.push(String(r.obj_id))
    vecs.push(toVec(r.blob))
  }
  const pos = new Map(ids.map((id, i) => [id, i]))
  const v = { ids, vecs, pos }
  VEC.set(dbPath, v)
  return v
}

/** 词表 = chunks.text_seg（jieba 分词结果，空格连接）的全部词 */
function vocabulary(dbPath: string): Set<string> {
  const hit = VOCAB.get(dbPath)
  if (hit) return hit
  const db = openRo(dbPath)
  const set = new Set<string>()
  for (const r of db.prepare('SELECT text_seg FROM chunks').iterate() as Iterable<Record<string, unknown>>) {
    const seg = r.text_seg
    if (typeof seg !== 'string') continue
    for (const w of seg.split(/\s+/)) if (w.length >= 2) set.add(w)
  }
  VOCAB.set(dbPath, set)
  return set
}

// ---------------------------------------------------------------------------
// 分词（语料词表最长匹配）+ 型号正则（A5；型号记号已收口到 shared/tokens.ts）
// ---------------------------------------------------------------------------

const MAX_TERM = 12

/** 语料词表最长匹配（≥2 字） + 型号记号补入（自定义词典） */
export function segment(question: string, vocab: Set<string>, extras: string[] = []): string[] {
  const s = question.replace(/\s+/g, '')
  const terms: string[] = []
  let i = 0
  while (i < s.length) {
    let matched = ''
    for (let len = Math.min(MAX_TERM, s.length - i); len >= 2; len--) {
      const cand = s.slice(i, i + len)
      if (vocab.has(cand)) { matched = cand; break }
    }
    if (matched) { terms.push(matched); i += matched.length } else { i += 1 }
  }
  for (const e of extras) if (!terms.includes(e)) terms.push(e)
  return [...new Set(terms)]
}

// ---------------------------------------------------------------------------
// 两路召回 + RRF
// ---------------------------------------------------------------------------

const norm = (v: ArrayLike<number>): number => {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i] * v[i]
  return Math.sqrt(s)
}

export function cosineTopK(dbPath: string, q: number[], k: number): Ranked[] {
  const { ids, vecs } = chunkVectors(dbPath)
  const qn = norm(q) || 1
  const scored: Ranked[] = []
  for (let i = 0; i < ids.length; i++) {
    const v = vecs[i]
    let d = 0
    for (let j = 0; j < 1024 && j < v.length; j++) d += v[j] * q[j]
    scored.push({ id: ids[i], score: d / ((norm(v) || 1) * qn) })
  }
  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
  return scored.slice(0, k)
}

export function keywordTopK(dbPath: string, terms: string[], k: number): { ranked: Ranked[]; mode: 'fts' | 'like-fallback' | 'none' } {
  if (terms.length === 0) return { ranked: [], mode: 'none' }
  const db = openRo(dbPath)
  const match = terms.map((t) => '"' + t.replace(/"/g, '') + '"').join(' OR ')
  try {
    const rows: Ranked[] = []
    for (const r of db
      .prepare('SELECT c.id AS id, bm25(chunks_fts) AS s FROM chunks_fts JOIN chunks c ON c.rowid = chunks_fts.rowid WHERE chunks_fts MATCH ? ORDER BY s LIMIT ?')
      .iterate(match, k) as Iterable<Record<string, unknown>>) {
      rows.push({ id: String(r.id), score: -Number(r.s) })
    }
    if (rows.length > 0) return { ranked: rows, mode: 'fts' }
  } catch {
    /* MATCH 语法不认（如纯符号）→ 走 LIKE 兜底，**不静默**：mode 会如实回报 */
  }
  // 兜底：LIKE 召回（二字词等短词；无分数，仅召回 —— §4.3）
  const rows: Ranked[] = []
  const seen = new Set<string>()
  for (const t of terms) {
    if (t.length > 4) continue
    for (const r of db.prepare('SELECT id FROM chunks WHERE text LIKE ? LIMIT ?').iterate('%' + t + '%', k) as Iterable<Record<string, unknown>>) {
      const id = String(r.id)
      if (seen.has(id)) continue
      seen.add(id)
      rows.push({ id, score: 0 })
    }
  }
  return { ranked: rows.slice(0, k), mode: rows.length ? 'like-fallback' : 'none' }
}

/** 冒烟与判据用：**只跑关键词路**（不编码、不开服务）—— 分词 + 命中 */
export function keywordProbe(chunkDb: string, question: string, k: number): { terms: string[]; ranked: Ranked[]; mode: string } {
  const terms = segment(question, vocabulary(chunkDb), patternTokens(question))
  const r = keywordTopK(chunkDb, terms, k)
  return { terms, ranked: r.ranked, mode: r.mode }
}

/** RRF：只比名次不比分数；缺席记 0；同分时**向量分高者先** */
export function rrf(a: Ranked[], b: Ranked[], k: number, vectorScore: Map<string, number>): Ranked[] {
  const m = new Map<string, number>()
  a.forEach((x, i) => m.set(x.id, (m.get(x.id) ?? 0) + 1 / (k + i + 1)))
  b.forEach((x, i) => m.set(x.id, (m.get(x.id) ?? 0) + 1 / (k + i + 1)))
  return [...m.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((x, y) => y.score - x.score || (vectorScore.get(y.id) ?? 0) - (vectorScore.get(x.id) ?? 0) || (x.id < y.id ? -1 : 1))
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export interface FusedResult {
  fused: Ranked[]
  terms: string[]
  vectorTop: Ranked[]
  keywordTop: Ranked[]
  keywordMode: 'fts' | 'like-fallback' | 'none'
  topSimilarity: number
}

/** ②③④ 步：向量路 + 关键词路 → RRF →（可选软偏置）→ **子块榜**（不落父块） */
export function fuseSubChunks(params: TextRetrievalParams): FusedResult {
  const { chunkDb, question, queryVec, config } = params

  // ③ 关键词路：分词（语料词表最长匹配 + 型号正则）
  const terms = segment(question, vocabulary(chunkDb), patternTokens(question))

  // ② 向量路
  const vectorTop = cosineTopK(chunkDb, queryVec, config.recallPerChannel)
  const vectorScore = new Map(vectorTop.map((x) => [x.id, x.score]))

  // ③ 关键词路
  const kw = keywordTopK(chunkDb, terms, config.recallPerChannel)

  // ④ RRF（融合分不再被任何范围放大）
  const fused = rrf(vectorTop, kw.ranked, config.rrfK, vectorScore)

  return {
    fused,
    terms,
    vectorTop,
    keywordTop: kw.ranked,
    keywordMode: kw.mode,
    topSimilarity: vectorTop.length > 0 ? vectorTop[0].score : 0,
  }
}

/**
 * ⑤⑥ 步：子块榜 → 父块（同父只收一次、凑够 `config.finalK` 停）→ 总量闸门
 *
 * 🔴 **闸门语义变更（2026-10-11，14- C4）**：原「三条合计 **3000 字**超则末条截」已**取消**——
 * 它实测约一成会截（p90 三条合计 3306 字），而截掉的是证据本体。现改为**安全阀**：
 * 配置 `text.charLimit` = 6000 字（父块 p90 1433 / max 1638，3 条最坏 ≈4914 字，正常**永远不触发**）；
 * 真正的预算改由提示词侧管（textEvidence 3400 token + maxTotalTokens 总量保险丝，超了**先裁历史**、
 * 再不够才裁证据末条且**显式标注**——证据永不静默截断）。仍触发即置 truncated=true 并留痕。
 */
export function collapseToParents(
  chunkDb: string,
  fused: Ranked[],
  config: TextConfig,
): { evidences: TextEvidence[]; truncated: boolean; chars: number } {
  const db = openRo(chunkDb)
  const evidences: TextEvidence[] = []
  const byTarget = new Map<string, TextEvidence>()
  // 🔴 v1.2 证据定位单轨化：**不再读** doc_id / chapter / section / page_start / page_end / asset_id，
  //    也不再 JOIN documents 或查 assets —— 定位与引用一律走块编号（chunkId）。
  //    （库里的列暂时保留，本模块已零引用 → 数据侧删列时本文件无需再改。）
  const metaStmt = db.prepare(
    'SELECT id, parent_id, kind, text FROM chunks WHERE id = ?',
  )
  for (let rank = 0; rank < fused.length && evidences.length < config.finalK; rank++) {
    const item = fused[rank]
    const row = metaStmt.get(item.id) as Record<string, unknown> | undefined
    if (!row) continue
    const targetId = (row.parent_id as string | null) ?? String(row.id)
    const existing = byTarget.get(targetId)
    if (existing) {
      existing.matches.push({ chunkId: item.id, rank: rank + 1 })
      continue
    }
    const trow = (targetId === String(row.id) ? row : (metaStmt.get(targetId) as Record<string, unknown> | undefined)) ?? row
    // 🔴 2026-10-22：kind='table' 已下线（语料无表格，该类型是旧库槽位继承的误标）
    const kind = 'parent' as const
    const ev: TextEvidence = {
      kind,
      chunkId: String(trow.id),
      text: String(trow.text ?? ''),
      matches: [{ chunkId: item.id, rank: rank + 1 }],
      score: item.score,
    }
    evidences.push(ev)
    byTarget.set(targetId, ev)
  }

  // ⑥ 总量闸门
  let chars = evidences.reduce((s, e) => s + e.text.length, 0)
  let truncated = false
  if (chars > config.charLimit && evidences.length > 0) {
    const last = evidences[evidences.length - 1]
    const over = chars - config.charLimit
    last.text = last.text.slice(0, Math.max(0, last.text.length - over))
    truncated = true
    chars = evidences.reduce((s, e) => s + e.text.length, 0)
  }

  return { evidences, truncated, chars }
}

/** 文本路（默认口径，**不含 Reranker**）：融合 → 落父块 */
export function retrieveText(params: TextRetrievalParams): TextRetrievalResult {
  const f = fuseSubChunks(params)
  const c = collapseToParents(params.chunkDb, f.fused, params.config)
  return {
    evidences: c.evidences,
    subChunkIds: f.fused.slice(0, params.config.recallPerChannel).map((x) => x.id),
    topSimilarity: f.topSimilarity,
    debug: {
      terms: f.terms,
      vectorTop: f.vectorTop.map((x) => x.id),
      keywordTop: f.keywordTop.map((x) => x.id),
      keywordMode: f.keywordMode,
      truncated: c.truncated,
      chars: c.chars,
    },
  }
}

/**
 * 文本路 + **Reranker**（A1/D25-20「接入但默认关闭」→ 2026-10-11 按 14- A1 **替换为父段落级、池 5**）。
 *
 * 口径（13- §3.4，负责人认可）：
 *   · 按**融合榜顺序**取前 `config.rerankPool` 个**不同父段落**，每段交**全文（一个字不截）**；
 *   · 打分只决定「挑哪 3 条」——**不碰尺子**（`topSimilarity` 仍取加偏置前的原始余弦）；
 *   · 🔴 **打分失败 / 超时一律退回原序继续走**（13- §3.10：打分的失败绝不能把「能回答」变成「不能回答」），
 *     由本函数内部兜底，**不再让 rerank 抛错把整条文本路打死**（旧口径的拒答隐患，13- §3.4 已登记）。
 *
 * 开关：`config/retrieval/default.json` 的 `reranker.enabled`（默认 false）；池值见 `text.rerankPool`。
 */
export async function retrieveTextWithRerank(
  params: TextRetrievalParams,
  rerankFn: (query: string, docs: string[]) => Promise<{ index: number; score: number }[]>,
  pool: number,
): Promise<TextRetrievalResult & { reranked: number; rerankMs: number; rerankFallback: boolean; rerankError?: string }> {
  const t0 = Date.now()
  const f = fuseSubChunks(params)
  const db = openRo(params.chunkDb)
  // 子块 → 父段落（同父归并；无父块的独立块自成一段——新库不应出现）
  const stmt = db.prepare('SELECT id, parent_id, text FROM chunks WHERE id = ?')
  const groups: { targetId: string; text: string; members: string[] }[] = []
  const byTarget = new Map<string, { targetId: string; text: string; members: string[] }>()
  for (const item of f.fused) {
    const row = stmt.get(item.id) as { id: string; parent_id: string | null; text: string } | undefined
    if (!row) continue
    const targetId = row.parent_id ?? row.id
    let g = byTarget.get(targetId)
    if (!g) {
      const trow = targetId === row.id ? row : (stmt.get(targetId) as { text: string } | undefined)
      g = { targetId, text: String(trow?.text ?? row.text ?? ''), members: [] }
      byTarget.set(targetId, g)
      groups.push(g)
    }
    if (!g.members.includes(item.id)) g.members.push(item.id)
  }
  const picked = groups.slice(0, Math.max(1, pool))

  // ★ 打分：池 = 前 N 个不同父段落，**全文不截**
  let order: Ranked[] = []
  let reranked = 0
  let rerankFallback = false
  let rerankError: string | undefined
  try {
    const scores = await rerankFn(params.question, picked.map((g) => g.text))
    const byIndex = new Map<number, number>()
    for (const s of scores) if (typeof s.index === 'number' && Number.isFinite(s.score)) byIndex.set(s.index, s.score)
    if (byIndex.size === 0) throw new Error('打分服务没有返回有效分数')
    const rankedGroups = picked
      .map((g, i) => ({ g, score: byIndex.get(i) ?? Number.NEGATIVE_INFINITY }))
      .sort((a, b) => b.score - a.score)
    const used = new Set<string>()
    for (const { g } of rankedGroups) {
      for (const id of g.members) {
        const item = f.fused.find((x) => x.id === id)
        if (item && !used.has(id)) { used.add(id); order.push({ id, score: byIndex.get(picked.indexOf(g)) ?? item.score }) }
      }
      reranked++
    }
    for (const item of f.fused) if (!used.has(item.id)) { used.add(item.id); order.push(item) }
  } catch (err) {
    // 🔴 兜底：退回原排序继续走，只记账、不失败
    rerankFallback = true
    rerankError = (err as Error).message
    order = [...f.fused]
  }

  const c = collapseToParents(params.chunkDb, order, params.config)
  return {
    evidences: c.evidences,
    subChunkIds: order.slice(0, params.config.recallPerChannel).map((x) => x.id),
    topSimilarity: f.topSimilarity,
    reranked,
    rerankMs: Date.now() - t0,
    rerankFallback,
    rerankError,
    debug: {
      terms: f.terms,
      vectorTop: f.vectorTop.map((x) => x.id),
      keywordTop: f.keywordTop.map((x) => x.id),
      keywordMode: f.keywordMode,
      truncated: c.truncated,
      chars: c.chars,
    },
  }
}
