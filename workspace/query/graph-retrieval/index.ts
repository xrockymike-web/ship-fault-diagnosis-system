/**
 * 图谱检索（第二路）+ 诊断路径（《技术总纲》§4.3.3 五步 / §5.6 方案 B + 决策 D24 A2/A4/A5/A6）
 *
 * 五步：
 *   ① 实体链接：**路B**（问题向量×实体向量 top-30）+ **路A**（**图路自算**的子块 top-30 → \`chunk_entities\` 反查）
 *      + **型号正则兜底**（A5：命中**直接置顶**）→ RRF → **候选 C(30)**；**同名每名 ≤1**（A4 平手规则）
 *   ② 子图：C 前 5–8 种子 → **2 跳** → 去重；**节点 ≤ 40**；**不加权**
 *   ③ 通路（**图上通路 · 无向**，13- §3.5.4 放宽四条 / 14- A6 改名去箭头）：**在 2 跳子图内枚举**、
 *      **完全无向**、**只走 导致/对应**、**≥3 节点封顶 5**；二级【共现关联】语义不变但同样 ≥3 节点；
 *      排序 = 预筛分降序 → 池封顶 40 → 预筛 20 → 打分取 3~5（13- §3.5.5，两处打分共用一个预算）。
 *      找不到 → 降级「任意关系」（非因果由关系名标注）→ 仍无则 `no_path`（不硬造）。
 *   ④ 诊断路径：受约束枚举「现象 → 原因 → 措施」→ 打分排序；**配对缺失并列展示、不强配**
 *   ⑤ 返回子图 + 路径 + 诊断路径（各带证据块）
 *
 * 🔴 三条纪律：**实体返回不加权**（权重只用于路径/诊断排序）；**共现边绝不当因果**（level 字段写明）；
 *    **每条路径每条边都能回指 chunk_id**。只读打开两库，路径由调用方注入（红线 R3）。
 *    🆕 2026-10-19：共现边（`cooccurrence_edges`）已迁入 **graph 库**。
 */
import { DatabaseSync } from 'node:sqlite'
import { patternTokens } from '../shared/tokens.ts'
import type {
  DiagnosticEdge,
  DiagnosticPath,
  GraphPath,
  GraphSeed,
  SubgraphLink,
  SubgraphNode,
} from '../shared/types'

export interface GraphConfig {
  entityRecall: number
  candidateK: number
  seedMin: number
  seedMax: number
  hops: number
  nodeLimit: number
  edgeLimit: number
  pathMaxHops: number
  pathFinal: number
  /** 🆕 14- A5：通路最少取几条 = max(pathMinFinal, …) 与诊断同口径（取 3~5 的「3」） */
  pathMinFinal?: number
  /** 🆕 13- §3.5.4 放宽第 4 条：通路 **≥ pathMinNodes 个节点**（原来 ≥2 就收 → 97% 两节点） */
  pathMinNodes?: number
  /** 🆕 13- §3.5.4：通路**封顶 pathMaxNodes 个节点**（原来无上限语义，现定 5） */
  pathMaxNodes?: number
  /** 🆕 14- A4：通路**池封顶**（实测 0~419 条跨 400 倍 → 必须封顶，超出按预筛分留高） */
  pathPoolLimit?: number
  /** 🆕 13- §3.5.2：种子打分池（12 → 取前 8 当种子；13 名之后分数记 -1） */
  seedRerankPool?: number
  /** 🆕 13- §3.5.5：通路预筛后交打分的条数（20） */
  prefilterPool?: number
  /** 🆕 13- §3.5.5：通路分 = max×最像 + mean×均值（两系数 14- A3 落 config 并标未标定） */
  prefilterMax?: number
  prefilterMean?: number
  tieEpsilon: number
  typePrior: string[]
}

export interface DiagnosticsConfig {
  finalK: number
  minK: number
  /** 🔴 死键：buildDiagnostics 从不读（BFS 的 maxHops 是另一个参数），见 config/retrieval 的 diagnostics._dead_key_note */
  maxHops: number
  lengthPenalty: number
  noEvidenceSimilarity: number
  relationWeights: Record<string, number>
}

export interface GraphRetrievalParams {
  graphDb: string
  chunkDb: string
  question: string
  queryVec: number[]
  config: GraphConfig
  diagnostics: DiagnosticsConfig
  /** 🆕 U4：用户自建图层 —— **只在内存里合并**；教材库/文件一个字不动 */
  userGraph?: UserGraphInput | null
  /** 用户知识库 revision（进缓存键，否则"加了看不到"） */
  userRev?: number
  /**
   * 🆕 打分注入（13- §3.5.2 种子 + §3.5.5 通路；由 qa-core 提供）。
   * 🔴 **两处打分共用一个预算**（负责人 2026-10-11 拍板「可以共用，推荐测试，然后放宽」）：
   * qa-core 进图谱路时取一次 deadline，本模块每次调用前先算 remaining，**剩余 ≤0 直接走兜底退回原序**，
   * 绝不因打分把整条路打死（13- §3.10）。
   */
  rerank?: GraphRerankInjection | null
}

/** 🆕 U4：从 user_data 读出来的自建图层（由 qa-core 注入；本模块**不碰文件**） */
export interface UserGraphInput {
  entities: { id: string; name: string; type: string; aliases?: string[] }[]
  triples: { subjectId: string; predicate: string; objectId: string }[]
  /** 自建实体向量（进"路B 语义召回"的候选池） */
  entityVec: Map<string, Float32Array>
}

export interface GraphRetrievalResult {
  seeds: GraphSeed[]
  nodes: SubgraphNode[]
  links: SubgraphLink[]
  causalPaths: GraphPath[]
  cooccurrencePaths: GraphPath[]
  noPath: boolean
  diagnostics: DiagnosticPath[]
  /** 🆕 P0-7 留痕（13- §3.11）：每处打分一行「池/重排条数/耗时/是否兜底」，由 qa-core 转进 notes 与 app.log */
  rerankNotes: string[]
}

/** 🆕 打分注入（见 GraphRetrievalParams.rerank） */
export interface GraphRerankInjection {
  /** 共用预算的截止时刻（Date.now() 基准，ms） */
  deadline: number
  fn: (query: string, docs: string[], timeoutMs: number) => Promise<{ index: number; score: number }[]>
}

interface Ent {
  /** 🆕 U4：来源（user = 用户自建；合并时标上） */
  origin?: 'curated' | 'user'
  /** 🆕 U4：自建实体的别名（名字/别名精确命中直接置顶） */
  aliases?: string[]
  id: string
  name: string
  type: string
  chunkIds: string[]
  /** 🆕 种子打分输入（13- §3.5.2「描述 + 属性**一个字不截**」；属性 mean 164 字，是真正的语义载体） */
  description: string
  attributes: string
}
interface Trip {
  s: string
  p: string
  o: string
  rel: string
  chunks: string[]
}

const DBS = new Map<string, DatabaseSync>()
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
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer)
}
function cos(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let d = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    d += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return d / ((Math.sqrt(na) || 1) * (Math.sqrt(nb) || 1))
}
// 型号 / 编号 tokens（A5 三道闸门：① 必须含数字；外两条在匹配时施加）→ shared/tokens.ts

interface Store {
  ents: Ent[]
  byId: Map<string, Ent>
  byName: Map<string, Ent[]>
  trips: Trip[]
  adj: Map<string, { other: string; rel: string; chunks: string[] }[]>
  deg: Map<string, number>
  entVec: Map<string, Float32Array>
  chunkEnt: Map<string, string[]>
  coo: Map<string, { a: string; b: string; w: number; chunks: string[] }>
  cooAdj: Map<string, { other: string; w: number; chunks: string[] }[]>
}
const STORE = new Map<string, Store>()

function loadStore(graphDb: string, chunkDb: string, userRev: number, user: UserGraphInput | null): Store {
  const key = graphDb + '|' + chunkDb + '|u' + userRev
  const hit = STORE.get(key)
  if (hit) return hit
  const g = openRo(graphDb)
  const ents: Ent[] = []
  for (const r of g
    .prepare('SELECT id, name, type, chunk_ids, description, attributes FROM entities')
    .iterate() as Iterable<Record<string, unknown>>) {
    ents.push({
      id: String(r.id),
      name: String(r.name ?? ''),
      type: String(r.type ?? ''),
      chunkIds: String(r.chunk_ids ?? '').split('|').map((s) => s.trim()).filter(Boolean),
      description: String(r.description ?? ''),
      attributes: String(r.attributes ?? ''),
    })
  }
  const byId = new Map(ents.map((e) => [e.id, e]))
  const byName = new Map<string, Ent[]>()
  for (const e of ents) {
    if (!byName.has(e.name)) byName.set(e.name, [])
    byName.get(e.name)!.push(e)
  }
  const relName = new Map<string, string>()
  for (const r of g.prepare('SELECT id, name FROM relation_types').iterate() as Iterable<Record<string, unknown>>) {
    relName.set(String(r.id), String(r.name ?? ''))
  }
  const trips: Trip[] = []
  const adj = new Map<string, { other: string; rel: string; chunks: string[] }[]>()
  const deg = new Map<string, number>()
  for (const r of g.prepare('SELECT subject_id, predicate_id, object_id, chunk_ids FROM triples').iterate() as Iterable<Record<string, unknown>>) {
    const s = String(r.subject_id)
    const o = String(r.object_id)
    const rel = relName.get(String(r.predicate_id)) ?? ''
    const chunks = String(r.chunk_ids ?? '').split('|').map((x) => x.trim()).filter(Boolean)
    trips.push({ s, p: rel, o, rel, chunks })
    if (!adj.has(s)) adj.set(s, [])
    if (!adj.has(o)) adj.set(o, [])
    adj.get(s)!.push({ other: o, rel, chunks })
    adj.get(o)!.push({ other: s, rel, chunks })
    deg.set(s, (deg.get(s) ?? 0) + 1)
    deg.set(o, (deg.get(o) ?? 0) + 1)
  }
  const entVec = new Map<string, Float32Array>()
  for (const r of g.prepare("SELECT obj_id, blob FROM vectors WHERE obj_type = 'entity'").iterate() as Iterable<Record<string, unknown>>) {
    entVec.set(String(r.obj_id), toVec(r.blob))
  }
  const chunkEnt = new Map<string, string[]>()
  for (const r of g.prepare('SELECT chunk_id, entity_id FROM chunk_entities').iterate() as Iterable<Record<string, unknown>>) {
    const c = String(r.chunk_id)
    if (!chunkEnt.has(c)) chunkEnt.set(c, [])
    chunkEnt.get(c)!.push(String(r.entity_id))
  }
  const cc = g   // 🆕 2026-10-19：共现边已迁入 graph 库，与主图同一连接
  const coo = new Map<string, { a: string; b: string; w: number; chunks: string[] }>()
  const cooAdj = new Map<string, { other: string; w: number; chunks: string[] }[]>()
  for (const r of cc.prepare('SELECT entity_a, entity_b, weight, chunk_ids FROM cooccurrence_edges').iterate() as Iterable<Record<string, unknown>>) {
    const a = String(r.entity_a)
    const b = String(r.entity_b)
    const w = Number(r.weight ?? 1)
    const chunks = String(r.chunk_ids ?? '').split('|').map((x) => x.trim()).filter(Boolean)
    coo.set(a + '\u0001' + b, { a, b, w, chunks })
    if (!cooAdj.has(a)) cooAdj.set(a, [])
    if (!cooAdj.has(b)) cooAdj.set(b, [])
    cooAdj.get(a)!.push({ other: b, w, chunks })
    cooAdj.get(b)!.push({ other: a, w, chunks })
  }
  // ---------------------------------------------------------------
  // 🆕 U4：**逻辑合并**用户自建图层（只在内存；教材文件与库一律不动）
  //   · 端点必须已存在（U1 已校验，这里再兜一层，脏数据不把图带坏）
  //   · 自建边没有 chunk 证据 → chunks 留空（界面显示"无原文依据"）
  // ---------------------------------------------------------------
  if (user) {
    for (const ue of user.entities) {
      if (byId.has(ue.id)) continue
      const e: Ent = { id: ue.id, name: ue.name, type: ue.type, chunkIds: [], origin: 'user', aliases: ue.aliases ?? [], description: '', attributes: '' }
      ents.push(e)
      byId.set(e.id, e)
      if (!byName.has(e.name)) byName.set(e.name, [])
      byName.get(e.name)!.push(e)
    }
    for (const ut of user.triples) {
      if (!byId.has(ut.subjectId) || !byId.has(ut.objectId)) continue
      trips.push({ s: ut.subjectId, p: ut.predicate, o: ut.objectId, rel: ut.predicate, chunks: [] })
      if (!adj.has(ut.subjectId)) adj.set(ut.subjectId, [])
      if (!adj.has(ut.objectId)) adj.set(ut.objectId, [])
      adj.get(ut.subjectId)!.push({ other: ut.objectId, rel: ut.predicate, chunks: [] })
      adj.get(ut.objectId)!.push({ other: ut.subjectId, rel: ut.predicate, chunks: [] })
      deg.set(ut.subjectId, (deg.get(ut.subjectId) ?? 0) + 1)
      deg.set(ut.objectId, (deg.get(ut.objectId) ?? 0) + 1)
    }
    for (const [id, v] of user.entityVec) if (!entVec.has(id)) entVec.set(id, v)
  }

  const st: Store = { ents, byId, byName, trips, adj, deg, entVec, chunkEnt, coo, cooAdj }
  STORE.set(key, st)
  return st
}

// 子块向量（路A 与「边绑定相似度」用；图路**自己算**，不依赖文本路 —— A2）
const CVEC = new Map<string, { ids: string[]; vecs: Float32Array[] }>()
function chunkVectors(chunkDb: string): { ids: string[]; vecs: Float32Array[] } {
  const hit = CVEC.get(chunkDb)
  if (hit) return hit
  const db = openRo(chunkDb)
  const ids: string[] = []
  const vecs: Float32Array[] = []
  for (const r of db.prepare('SELECT obj_id, blob FROM vectors').iterate() as Iterable<Record<string, unknown>>) {
    ids.push(String(r.obj_id))
    vecs.push(toVec(r.blob))
  }
  const v = { ids, vecs }
  CVEC.set(chunkDb, v)
  return v
}

// ---------------------------------------------------------------------------
// ① 实体链接
// ---------------------------------------------------------------------------

export async function linkEntities(
  params: GraphRetrievalParams,
  st: Store,
): Promise<{ candidates: Ent[]; seeds: GraphSeed[]; rerankNotes: string[] }> {
  const { config, queryVec, question, chunkDb } = params
  const rrfK = 60

  // 路 B（语义）
  const semantic: { id: string; score: number }[] = []
  for (const [id, v] of st.entVec) semantic.push({ id, score: cos(queryVec, v) })
  semantic.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
  const semanticTop = semantic.slice(0, config.entityRecall)
  const semScore = new Map(semanticTop.map((x) => [x.id, x.score]))

  // 路 A（文本证据）：**图路自算**子块 top-30 → chunk_entities 反查
  const cv = chunkVectors(chunkDb)
  const ranked: { id: string; score: number }[] = []
  for (let i = 0; i < cv.ids.length; i++) ranked.push({ id: cv.ids[i], score: cos(queryVec, cv.vecs[i]) })
  ranked.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
  const subTop = ranked.slice(0, config.entityRecall)
  const textScore = new Map<string, number>()
  subTop.forEach((item, i) => {
    for (const eid of st.chunkEnt.get(item.id) ?? []) {
      textScore.set(eid, (textScore.get(eid) ?? 0) + 1 / (rrfK + i + 1))
    }
  })
  const textTop = [...textScore.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    .slice(0, config.entityRecall)

  // RRF 合并
  const rrf = new Map<string, number>()
  semanticTop.forEach((x, i) => rrf.set(x.id, (rrf.get(x.id) ?? 0) + 1 / (rrfK + i + 1)))
  textTop.forEach((x, i) => rrf.set(x.id, (rrf.get(x.id) ?? 0) + 1 / (rrfK + i + 1)))

  // 型号兜底（A5）：精确命中优先、子串次之；**命中直接置顶**
  const patternIds: string[] = []
  for (const t of patternTokens(question)) {
    const low = t.toLowerCase()
    for (const e of st.ents) {
      if (e.name.toLowerCase() === low && !patternIds.includes(e.id)) patternIds.push(e.id)
    }
    if (t.length >= 2 && !/^[0-9]+$/.test(t)) {
      for (const e of st.ents) {
        if (e.name.toLowerCase().includes(low) && !patternIds.includes(e.id)) patternIds.push(e.id)
      }
    }
  }

  // 🆕 U4：**自建实体**的名字 / 别名在问题里字符级命中 → **直接置顶**
  //   为什么单独一条：中文实体名不会被 A5 的 token 正则抓到，而自建实体又没有 chunk 走"路A 文本反查"，
  //   只靠语义路会排不进种子 → 用户加了实体却在回答里看不到。
  //   🔴 **只对 origin==='user' 生效**：教材的链接行为**一字不动**（空知识库 = 完全不变）。
  const userHits: string[] = []
  for (const e of st.ents) {
    if (e.origin !== 'user') continue
    const names = [e.name, ...(e.aliases ?? [])].filter(Boolean)
    if (names.some((n) => n.length >= 2 && question.indexOf(n) >= 0)) {
      if (!patternIds.includes(e.id) && !userHits.includes(e.id)) userHits.push(e.id)
    }
  }

  // 🔴 2026-10-19：软偏置（A7 范围内的实体融合分 ×factor）已删除。
  //    候选 C 的排序只剩「型号命中置顶 → RRF 名次 → 同名约束（A4）」。
  const scoreOf = (id: string): number => rrf.get(id) ?? 0

  // 排序：型号命中置顶 → RRF 名次 → 同名约束（A4）
  const head = [...userHits, ...patternIds]
  const rest = [...rrf.keys()]
    .sort((a, b) => scoreOf(b) - scoreOf(a) || (a < b ? -1 : 1))
    .filter((id) => !patternIds.includes(id) && !userHits.includes(id))

  // ★ 第 2 步 · 种子打分（13- §3.5.2；14- 施工单 2，负责人认可的图谱路定稿）
  //   取 RRF 前 seedRerankPool（12）个候选，每个拼「名字（类型）：描述全文 ｜ 属性全文」，
  //   **一个字不截**（属性是真正的语义载体，截 80 字 = 切掉全库 55.4% 属性内容 —— 13- §3.5.2）
  //   → 按分重排**只动这 N 个内部顺序**，其余名次不变（=「13 名之后分数记 -1」的召回上限语义）
  //   🔴 失败/超预算一律退回原序（13- §3.10：打分的失败绝不能把「能回答」变成「不能回答」）
  const rerankNotes: string[] = []
  const poolN = Math.max(0, config.seedRerankPool ?? 0)
  let scored = rest
  if (params.rerank && poolN > 1 && rest.length > 1) {
    const pool = rest.slice(0, Math.min(poolN, rest.length))
    const t0 = Date.now()
    try {
      const remaining = params.rerank.deadline - Date.now()
      if (remaining <= 0) throw new Error('打分共用预算已用尽')
      const docs = pool.map((id) => {
        const e = st.byId.get(id)!
        return e.name + '（' + e.type + '）：' + (e.description || '（无描述）') + ' ｜ ' + (e.attributes || '（无属性）')
      })
      const scores = await params.rerank.fn(params.question, docs, remaining)
      const byIdx = new Map<number, number>()
      for (const s of scores) if (Number.isFinite(s.score)) byIdx.set(s.index, s.score)
      if (byIdx.size === 0) throw new Error('打分服务没有返回有效分数')
      const reordered = pool
        .map((id, i) => ({ id, score: byIdx.get(i) ?? Number.NEGATIVE_INFINITY }))
        .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
        .map((x) => x.id)
      scored = [...reordered, ...rest.slice(pool.length)]
      rerankNotes.push('图路种子打分：池' + pool.length + '/重排' + reordered.length + '条/' + (Date.now() - t0) + 'ms')
    } catch (err) {
      rerankNotes.push('图路种子打分兜底（退回原序）：' + (err as Error).message + '/' + (Date.now() - t0) + 'ms')
    }
  }
  const ordered = [...head, ...scored]
  const taken = new Set<string>()
  const candidates: Ent[] = []
  const seeds: GraphSeed[] = []
  for (const id of ordered) {
    const e = st.byId.get(id)
    if (!e || taken.has(e.name)) continue
    // 同名组内挑一行
    const group = st.byName.get(e.name) ?? [e]
    let winner = group[0]
    const sorted = [...group].sort((a, b) => scoreOf(b.id) - scoreOf(a.id))
    if (sorted.length > 1 && Math.abs(scoreOf(sorted[0].id) - scoreOf(sorted[1].id)) <= config.tieEpsilon) {
      const prior = (t: string): number => {
        const i = config.typePrior.indexOf(t)
        return i < 0 ? config.typePrior.length : i
      }
      winner = [...group].sort(
        (a, b) =>
          prior(a.type) - prior(b.type) ||
          b.chunkIds.length - a.chunkIds.length ||
          (a.id < b.id ? -1 : 1),
      )[0]
    } else {
      winner = sorted[0]
    }
    taken.add(e.name)
    candidates.push(winner)
    seeds.push({
      entityId: winner.id,
      name: winner.name,
      type: winner.type,
      evidenceChunkIds: winner.chunkIds,
      from: {
        semantic: semScore.has(winner.id) ? semScore.get(winner.id) : undefined,
        text: textScore.has(winner.id) ? textScore.get(winner.id) : undefined,
        pattern: patternIds.includes(winner.id) ? true : undefined,
      },
      score: scoreOf(winner.id),
    })
    if (candidates.length >= config.candidateK) break
  }
  return { candidates, seeds, rerankNotes }
}

// ---------------------------------------------------------------------------
// ② 子图
// ---------------------------------------------------------------------------

function buildSubgraph(st: Store, candidates: Ent[], config: GraphConfig): { nodes: SubgraphNode[]; links: SubgraphLink[] } {
  const cSet = new Set(candidates.map((e) => e.id))
  const seedIds = candidates.slice(0, config.seedMax).map((e) => e.id)
  const dist = new Map<string, number>()
  const q: string[] = [...seedIds]
  seedIds.forEach((s) => dist.set(s, 0))
  while (q.length > 0) {
    const u = q.shift()!
    const d = dist.get(u)!
    if (d >= config.hops) continue
    for (const e of st.adj.get(u) ?? []) {
      if (!dist.has(e.other)) {
        dist.set(e.other, d + 1)
        q.push(e.other)
      }
    }
  }
  const sel = [...dist.entries()]
    .sort(
      (a, b) =>
        a[1] - b[1] ||
        (cSet.has(b[0]) ? 1 : 0) - (cSet.has(a[0]) ? 1 : 0) ||
        (st.deg.get(b[0]) ?? 0) - (st.deg.get(a[0]) ?? 0),
    )
    .slice(0, config.nodeLimit)
    .map(([id]) => id)
  const S = new Set(sel)
  const nodes: SubgraphNode[] = sel.map((id) => {
    const e = st.byId.get(id)!
    return { entityId: id, name: e.name, type: e.type, hop: dist.get(id) ?? 99 }
  })
  // 边：只让**诊断类边**（导致/对应）优先，再补结构边；上限 edgeLimit
  const relRank = (r: string): number => (r === '导致' ? 0 : r === '对应' ? 1 : 2)
  const links: SubgraphLink[] = st.trips
    .filter((t) => S.has(t.s) && S.has(t.o))
    .sort((a, b) => relRank(a.rel) - relRank(b.rel))
    .slice(0, config.edgeLimit)
    .map((t) => ({
      from: t.s,
      fromName: st.byId.get(t.s)?.name ?? t.s,
      to: t.o,
      toName: st.byId.get(t.o)?.name ?? t.o,
      relation: t.rel,
      evidenceChunkIds: t.chunks,
    }))
  return { nodes, links }
}

// ---------------------------------------------------------------------------
// ③ 路径
// ---------------------------------------------------------------------------

function bfs(
  adj: Map<string, { other: string }[]>,
  start: string,
  goal: string,
  maxHops: number,
  allowed: (id: string) => boolean,
): string[] | null {
  const prev = new Map<string, string>()
  const seen = new Set<string>([start])
  let frontier = [start]
  for (let d = 1; d <= maxHops; d++) {
    const next: string[] = []
    for (const u of frontier) {
      for (const e of adj.get(u) ?? []) {
        if (seen.has(e.other)) continue
        if (e.other !== goal && !allowed(e.other)) continue
        seen.add(e.other)
        prev.set(e.other, u)
        if (e.other === goal) {
          const path = [goal]
          let cur = goal
          while (prev.has(cur)) {
            cur = prev.get(cur)!
            path.unshift(cur)
          }
          return path
        }
        next.push(e.other)
      }
    }
    frontier = next
  }
  return null
}

function pathOf(st: Store, ids: string[], level: 'causal' | 'cooccurrence', directed: boolean): GraphPath {
  const edges: GraphPath['edges'] = []
  for (let i = 0; i + 1 < ids.length; i++) {
    const a = ids[i]
    const b = ids[i + 1]
    if (level === 'causal') {
      const t = st.trips.find((x) => (x.s === a && x.o === b) || (!directed && x.s === b && x.o === a))
      edges.push({ relation: t?.rel ?? '', from: a, to: b, evidenceChunkIds: t?.chunks ?? [] })
    } else {
      const e = st.coo.get(a + '\u0001' + b) ?? st.coo.get(b + '\u0001' + a)
      edges.push({ relation: '共现关联', from: a, to: b, evidenceChunkIds: e?.chunks ?? [] })
    }
  }
  return {
    level,
    directed,
    nodes: ids.map((id) => {
      const e = st.byId.get(id)!
      return { entityId: id, name: e.name, type: e.type }
    }),
    edges,
  }
}

function weightSum(st: Store, ids: string[]): number {
  let s = 0
  for (let i = 0; i + 1 < ids.length; i++) {
    const t = st.trips.find((x) => (x.s === ids[i] && x.o === ids[i + 1]) || (x.s === ids[i + 1] && x.o === ids[i]))
    s += t ? 1 : 0
  }
  return s
}

/**
 * ③ 通路 —— **「图上通路」放宽四条**（13- §3.5.4，负责人 2026-10-10 指示；定案见 14- §3.1/§3.2）
 *   ① 搜索范围 = **2 跳子图内**枚举（不再 30 候选两两配对、中间点**不再必须在候选内** —— 病根 2）
 *   ② **完全无向**（实测：方向正确的「导致→导致」两跳链 0 条、纯导致无向 3 节点链 617 条里方向全对的 0 条 → 必须去箭头）
 *   ③ 只走 **导致 / 对应**（放宽前 28% 是非因果关系：包含/发生/使用…）
 *   ④ **≥3 节点、封顶 5 节点**（原来 ids.length ≥ 2 就收 → 实测 97% 两节点；病根 1）
 * 排序 = **预筛分降序**（不再 hops 升序 —— 病根 3：长链反而排后面被砍）→ 池封顶 pathPoolLimit(40)。
 * 第一档（只走导致/对应）0 条时**降级到第二档：任意关系**，产出链子由关系名可见性标注「非因果」（14- A8）。
 * 二级【共现关联】语义不变（端点在候选、中间自由、中间点必须有证据），但**同样 ≥3 节点**（14- C7）。
 */
function buildPaths(
  st: Store,
  candidates: Ent[],
  subgraphIds: string[],
  config: GraphConfig,
  pathScoreOf: (ids: string[]) => number,
): { causalPool: GraphPath[]; cooPool: GraphPath[]; tier: 'diagnosis' | 'any' } {
  const cIds = candidates.map((e) => e.id)
  const nodeSet = new Set(subgraphIds)
  const minNodes = Math.max(3, config.pathMinNodes ?? 3)
  const maxNodes = Math.max(minNodes, config.pathMaxNodes ?? 5)
  const poolLimit = Math.max(1, config.pathPoolLimit ?? 40)
  const DIAG = new Set(['导致', '对应'])
  const pri = (r: string): number => (r === '导致' ? 0 : r === '对应' ? 1 : 2)
  const canon = (path: string[]): string => {
    const a = path.join('>')
    const b = [...path].reverse().join('>')
    return a < b ? a : b
  }

  /** 无向邻接（限定子图内 + 关系白名单；平行边只留优先级最高的一条，保证一跳一关系） */
  const mkIdx = (allow: (rel: string) => boolean): Map<string, Map<string, string>> => {
    const m = new Map<string, Map<string, string>>()
    for (const t of st.trips) {
      if (!allow(t.rel)) continue
      if (t.s === t.o) continue
      if (!nodeSet.has(t.s) || !nodeSet.has(t.o)) continue
      for (const [a, b] of [[t.s, t.o], [t.o, t.s]]) {
        let inner = m.get(a)
        if (!inner) { inner = new Map(); m.set(a, inner) }
        const prev = inner.get(b)
        if (prev === undefined || pri(t.rel) < pri(prev)) inner.set(b, t.rel)
      }
    }
    return m
  }

  const mkPath = (ids: string[], idx: Map<string, Map<string, string>>): GraphPath => {
    const edges: GraphPath['edges'] = []
    for (let k = 0; k + 1 < ids.length; k++) {
      const rel = idx.get(ids[k])?.get(ids[k + 1]) ?? ''
      const t = st.trips.find(
        (x) =>
          (x.s === ids[k] && x.o === ids[k + 1]) || (x.s === ids[k + 1] && x.o === ids[k]),
      )
      edges.push({ relation: rel, from: ids[k], to: ids[k + 1], evidenceChunkIds: t?.chunks ?? [] })
    }
    return {
      level: 'causal',
      directed: false, // 🔴 无向：去箭头的建模依据见上
      nodes: ids.map((id) => {
        const e = st.byId.get(id)!
        return { entityId: id, name: e.name, type: e.type }
      }),
      edges,
    }
  }

  /** DFS 枚举**极大链**（到长上限或走不动才收，避免 A-B-C 与 A-B-C-D 互为前缀重复计数） */
  const enumerate = (idx: Map<string, Map<string, string>>): string[][] => {
    const seen = new Set<string>()
    const out: string[][] = []
    let steps = 0
    const cap = 20000 // 枚举保险（子图 40 节点 / 深 4，正常远小于此）
    const walk = (path: string[]): void => {
      if (steps > cap) return
      steps++
      const id = path[path.length - 1]
      let extended = false
      if (path.length < maxNodes) {
        for (const next of idx.get(id)?.keys() ?? []) {
          if (path.includes(next)) continue
          extended = true
          walk([...path, next])
          if (steps > cap) return
        }
      }
      if (!extended && path.length >= minNodes) {
        const key = canon(path)
        if (!seen.has(key)) { seen.add(key); out.push(path) }
      }
    }
    for (const s of subgraphIds) {
      walk([s])
      if (steps > cap) break
    }
    return out
  }

  // —— 第一档：只走 导致/对应；0 条 → 第二档：任意关系（14- A8 降级阶梯）——
  let tier: 'diagnosis' | 'any' = 'diagnosis'
  let idx = mkIdx((rel) => DIAG.has(rel))
  let paths = enumerate(idx)
  if (paths.length === 0 && subgraphIds.length > 1) {
    tier = 'any'
    idx = mkIdx(() => true)
    paths = enumerate(idx)
  }

  const scored = paths.map((ids) => ({ ids, p: mkPath(ids, idx), s: pathScoreOf(ids) }))
  // 🔴 建池顺序（2026-10-11 负责人拍板 · 丙案，14- §3.5）：**长度降序 → 相似度降序** ——
  //    「先看最长的（6→5→4→3，最少 3）」，长链必须先占住池位，不被一堆 3 节点短链挤出封顶；
  //    相似度是**同长度内**的排序键（决定谁能进 rerank 的预筛名额）。
  scored.sort(
    (a, b) =>
      b.ids.length - a.ids.length ||
      b.s - a.s ||
      weightSum(st, b.ids) - weightSum(st, a.ids) ||
      (a.ids.join('>') < b.ids.join('>') ? -1 : 1),
  )
  const causalPool = scored.slice(0, poolLimit).map((x) => x.p)

  // —— 二级【共现关联】：语义不变（端点在候选、中间自由、中间点必须有证据），但同样 ≥3 节点（14- C7）——
  const coo: { p: GraphPath; hops: number; w: number }[] = []
  const cooSeen = new Set<string>(causalPool.map((c) => c.nodes.map((n) => n.entityId).join('>')))
  const withEvidence = (id: string): boolean => (st.byId.get(id)?.chunkIds.length ?? 0) > 0
  for (let i = 0; i < cIds.length && coo.length < config.pathFinal * 3; i++) {
    for (let j = i + 1; j < cIds.length; j++) {
      const a = cIds[i]
      const b = cIds[j]
      if (cooSeen.has(a + '>' + b)) continue
      const ids = bfs(st.cooAdj as Map<string, { other: string; w: number; chunks: string[] }[]>, a, b, config.pathMaxHops, withEvidence)
      if (!ids || ids.length < minNodes) continue // 🔴 ≥3 节点（14- C7）
      const key = ids.join('>')
      const rev = [...ids].reverse().join('>')
      if (cooSeen.has(key) || cooSeen.has(rev)) continue
      cooSeen.add(key)
      let w = 0
      for (let k = 0; k + 1 < ids.length; k++) {
        const e = st.coo.get(ids[k] + '\u0001' + ids[k + 1]) ?? st.coo.get(ids[k + 1] + '\u0001' + ids[k])
        w += e?.w ?? 0
      }
      coo.push({ p: pathOf(st, ids, 'cooccurrence', false), hops: ids.length - 1, w })
    }
  }
  coo.sort((x, y) => x.hops - y.hops || y.w - x.w)
  return { causalPool, cooPool: coo.map((x) => x.p), tier }
}

// ---------------------------------------------------------------------------
// ④ 诊断路径（§5.6 方案 B + A6 打分）
// ---------------------------------------------------------------------------

function buildDiagnostics(
  params: GraphRetrievalParams,
  st: Store,
  candidates: Ent[],
  chunkSim: Map<string, number>,
): DiagnosticPath[] {
  const cfg = params.diagnostics
  const w = (rel: string): number => cfg.relationWeights[rel] ?? 0.2
  const simOf = (chunks: string[]): number => {
    let best: number | null = null
    for (const c of chunks) {
      const s = chunkSim.get(c)
      if (s === undefined) continue
      if (best === null || s > best) best = s
    }
    return best === null ? cfg.noEvidenceSimilarity : best
  }
  const mkEdge = (rel: string, from: string, to: string, chunks: string[]): DiagnosticEdge => ({
    relation: rel,
    from,
    to,
    weight: w(rel),
    similarity: simOf(chunks),
    evidenceChunkIds: chunks,
  })
  const score = (edges: DiagnosticEdge[]): number => {
    if (edges.length === 0) return 0
    const avg = edges.reduce((s, e) => s + e.weight * e.similarity, 0) / edges.length
    return avg * Math.pow(cfg.lengthPenalty, edges.length - 1)
  }
  const info = (id: string): { entityId: string; name: string; type: string } => {
    const e = st.byId.get(id)!
    return { entityId: id, name: e.name, type: e.type }
  }

  const out: DiagnosticPath[] = []
  const phenomena = candidates.filter((e) => e.type === '故障现象')
  for (const ph of phenomena) {
    // 现象 ←导致← 原因
    const causes = st.trips.filter((t) => t.rel === '导致' && t.o === ph.id)
    // 现象 --对应--> 措施
    const directMeasures = st.trips.filter((t) => t.rel === '对应' && t.s === ph.id)
    if (causes.length === 0) {
      for (const m of directMeasures) {
        const edges = [mkEdge('对应', ph.id, m.o, m.chunks)]
        out.push({ rank: 0, score: score(edges), phenomenon: info(ph.id), cause: null, measures: [info(m.o)], edges, pairMissing: true })
      }
      continue
    }
    for (const c of causes) {
      const paired = st.trips.filter((t) => t.rel === '对应' && t.s === c.s)
      if (paired.length > 0) {
        for (const m of paired) {
          const edges = [mkEdge('导致', c.s, ph.id, c.chunks), mkEdge('对应', c.s, m.o, m.chunks)]
          out.push({ rank: 0, score: score(edges), phenomenon: info(ph.id), cause: info(c.s), measures: [info(m.o)], edges, pairMissing: false })
        }
      } else {
        // 配对缺失：**原因与措施并列、不强配**（§5.6.3 结论 3）
        const edges = [mkEdge('导致', c.s, ph.id, c.chunks)]
        out.push({ rank: 0, score: score(edges), phenomenon: info(ph.id), cause: info(c.s), measures: [], edges, pairMissing: true })
      }
    }
  }
  // 🔴 破并列（14- C1「乙」，负责人整包确认）：诊断分数实测**大面积并列**（Q3/Q4 五条同分、
  //    top5 实际由枚举顺序决定）。同分时 ① 先比**证据块数**（多者先）② 再比**原因实体与问题的余弦**
  //    ③ 仍平才落回枚举序（候选序只作最后兜底 —— 14- C1 明确「甲」不做）。
  const evCount = (pd: DiagnosticPath): number => {
    const s = new Set<string>()
    for (const e of pd.edges) for (const c of e.evidenceChunkIds) s.add(c)
    return s.size
  }
  const causeSim = (pd: DiagnosticPath): number => {
    const v = pd.cause ? st.entVec.get(pd.cause.entityId) : undefined
    return v ? cos(params.queryVec, v) : 0
  }
  out.sort((a, b) => b.score - a.score || evCount(b) - evCount(a) || causeSim(b) - causeSim(a))
  const keep = Math.min(out.length, Math.max(cfg.minK, cfg.finalK))
  return out.slice(0, keep).map((p, i) => ({ ...p, rank: i + 1 }))
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export async function retrieveGraph(params: GraphRetrievalParams): Promise<GraphRetrievalResult> {
  const st = loadStore(params.graphDb, params.chunkDb, params.userRev ?? 0, params.userGraph ?? null)
  const link = await linkEntities(params, st)
  const { candidates, seeds } = link
  const rerankNotes: string[] = [...link.rerankNotes]
  const { nodes, links } = buildSubgraph(st, candidates, params.config)
  const subgraphIds = nodes.map((n) => n.entityId)

  // （软偏置已在 linkEntities 内、**选 C 之前**作用 —— 见那里的注释；此处不再二次排序）

  // ★ 预筛分（13- §3.5.5 方案 B）：**复用已有实体向量**，零 embed（实测 2 ms / 召回 2.75 优于 embed 701 ms / 2.54）
  const wMax = params.config.prefilterMax ?? 0.6
  const wMean = params.config.prefilterMean ?? 0.4
  const pathScoreOf = (ids: string[]): number => {
    const sims: number[] = []
    for (const id of ids) {
      const v = st.entVec.get(id)
      if (v) sims.push(cos(params.queryVec, v))
    }
    if (sims.length === 0) return 0
    let mx = sims[0]
    let sum = 0
    for (const s of sims) { if (s > mx) mx = s; sum += s }
    return wMax * mx + wMean * (sum / sims.length)
  }

  const { causalPool, cooPool, tier } = buildPaths(st, candidates, subgraphIds, params.config, pathScoreOf)
  if (tier === 'any') rerankNotes.push('图上通路降级阶梯：第 2 档 任意关系（非因果由关系名标注，14- A8）→ 产出 ' + causalPool.length + ' 条')

  // ★ 第 5 步 · 预筛 → 打分 → 取 3~5（13- §3.5.5；A5 = max(pathMinFinal, …) 与诊断同口径）
  const take = Math.max(1, params.config.pathFinal)
  const minFinal = Math.max(1, params.config.pathMinFinal ?? 3)
  let causal: GraphPath[] = []
  if (causalPool.length === 0) {
    causal = []
  } else if (params.rerank && causalPool.length > 1) {
    const preN = Math.max(1, params.config.prefilterPool ?? 20)
    // 🔴 预筛 = **直接按池序取前 N**（2026-10-11 负责人拍板「先看最长的…收成池，然后相似度，然后 reranker」）：
    //    池序 = 长度降序 → 相似度降序 → 所以这一步是**长度分层**（6 节点全进、5 节点全进…）
    //    **相似度是同长度内的排序键**（决定短链谁能挤进剩余名额），长链一条不漏地交给打分。
    //    ⚠ 曾改为「池内全局按相似度取 20」→ 实测把长链挡在打分之外（打分档首条退回 3 节点），已回退。
    const pre = causalPool.slice(0, preN)
    const t0 = Date.now()
    try {
      const remaining = params.rerank.deadline - Date.now()
      if (remaining <= 0) throw new Error('打分共用预算已用尽')
      const docs = pre.map((x) => x.nodes.map((n) => n.name).join(' → '))
      const scores = await params.rerank.fn(params.question, docs, remaining)
      const byIdx = new Map<number, number>()
      for (const s of scores) if (Number.isFinite(s.score)) byIdx.set(s.index, s.score)
      if (byIdx.size === 0) throw new Error('打分服务没有返回有效分数')
      const ordered = pre
        .map((x, i) => ({ x, s: byIdx.get(i) ?? Number.NEGATIVE_INFINITY }))
        .sort((a, b) => b.s - a.s)
      causal = ordered.slice(0, take).map((z) => z.x)
      // 🔴 展示顺序（丙案）：**长度降序**（同长度按 rerank 分，Array.sort 稳定）
      causal.sort((a, b) => b.nodes.length - a.nodes.length)
      rerankNotes.push(
        '图路通路打分：池' + causalPool.length + '→预筛' + pre.length + '→取' + causal.length + '条/' + (Date.now() - t0) + 'ms',
      )
    } catch (err) {
      causal = causalPool
        .slice(0, Math.max(minFinal, Math.min(take, causalPool.length)))
        .sort((a, b) => b.nodes.length - a.nodes.length)
      rerankNotes.push('图路通路打分兜底（退回预筛原序）：' + (err as Error).message + '/' + (Date.now() - t0) + 'ms')
    }
  } else {
    // 无打分档：池已按「长度 → 相似度」排好，直接取；展示同样长度降序（稳定）
    causal = causalPool
      .slice(0, Math.max(minFinal, Math.min(take, causalPool.length)))
      .sort((a, b) => b.nodes.length - a.nodes.length)
  }
  const coo = cooPool.slice(0, take)

  // 边绑定相似度：块向量余弦（A6）
  const cv = chunkVectors(params.chunkDb)
  const chunkSim = new Map<string, number>()
  for (let i = 0; i < cv.ids.length; i++) chunkSim.set(cv.ids[i], cos(params.queryVec, cv.vecs[i]))

  const diagnostics = buildDiagnostics(params, st, candidates, chunkSim)
  return {
    seeds,
    nodes,
    links,
    causalPaths: causal,
    cooccurrencePaths: coo,
    noPath: causal.length === 0 && coo.length === 0,
    diagnostics,
    rerankNotes,
  }
}
