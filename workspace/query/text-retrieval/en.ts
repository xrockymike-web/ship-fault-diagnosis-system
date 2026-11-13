/** 英文文本路：英文 FTS（chunks_fts_en）+ 同一套中文向量（跨语言）→ RRF → 父块（text_en）。 */
import type { TextEvidence } from '../shared/types'
import { openRo } from '../shared/sqlite'
import { cosineTopK, rrf } from './index'

const STOP = new Set(['the','and','for','with','that','this','from','are','was','were','has','have','had','not','but','you','your','can','could','should','would','about','into','when','what','which','how','why','does','did','will','its','their','there','then','than','them','they','been','being','also','more','most','some','such','only','other','very','just','over','under','between','after','before','during','while','where','who','whom','whose'])

export function enTokens(q: string): string[] {
  const raw = q.toLowerCase().match(/[a-z0-9][a-z0-9_.\-]*/g) ?? []
  const out: string[] = []
  for (const w of raw) {
    if (w.length < 3 || STOP.has(w) || out.includes(w)) continue
    out.push(w)
  }
  return out
}

function enKeywordTopK(dbPath: string, terms: string[], k: number): { ranked: { id: string; score: number }[]; mode: 'fts' | 'none' } {
  if (terms.length === 0) return { ranked: [], mode: 'none' }
  const db = openRo(dbPath)
  const match = terms.map((t) => '"' + t.replace(/"/g, '') + '"').join(' OR ')
  try {
    const rows: { id: string; score: number }[] = []
    for (const r of db
      .prepare('SELECT c.id AS id, bm25(chunks_fts_en) AS s FROM chunks_fts_en JOIN chunks c ON c.rowid = chunks_fts_en.rowid WHERE chunks_fts_en MATCH ? ORDER BY s LIMIT ?')
      .iterate(match, k) as Iterable<Record<string, unknown>>) {
      rows.push({ id: String(r.id), score: -Number(r.s) })
    }
    return { ranked: rows, mode: rows.length ? 'fts' : 'none' }
  } catch {
    return { ranked: [], mode: 'none' }
  }
}

export interface TextCfg { recallPerChannel: number; finalK: number; rrfK: number; charLimit: number }

/** 英文文本路：英文 FTS + 同一套中文向量（跨语言）→ RRF → 父块（text_en） */
export function retrieveTextEn(params: { chunkDb: string; question: string; queryVec: number[]; config: TextCfg }) {
  const { chunkDb, question, queryVec, config } = params
  const terms = enTokens(question)
  const kw = enKeywordTopK(chunkDb, terms, config.recallPerChannel)
  const vec = cosineTopK(chunkDb, queryVec, config.recallPerChannel)
  const fused = rrf(vec, kw.ranked, config.rrfK, new Map(vec.map((x) => [x.id, x.score])))
  const db = openRo(chunkDb)
  const stmt = db.prepare('SELECT id, parent_id, kind, text, text_en FROM chunks WHERE id = ?')
  const evidences: TextEvidence[] = []
  const byTarget = new Map<string, TextEvidence>()
  for (let rank = 0; rank < fused.length && evidences.length < config.finalK; rank++) {
    const item = fused[rank]
    const row = stmt.get(item.id) as Record<string, unknown> | undefined
    if (!row) continue
    const targetId = (row.parent_id as string | null) ?? String(row.id)
    const existing = byTarget.get(targetId)
    if (existing) { existing.matches.push({ chunkId: item.id, rank: rank + 1 }); continue }
    const trow = (targetId === String(row.id) ? row : (stmt.get(targetId) as Record<string, unknown> | undefined)) ?? row
    const text = String(trow.text_en ?? trow.text ?? '')
    const ev: TextEvidence = {
      kind: 'parent',
      chunkId: String(trow.id),
      text,
      matches: [{ chunkId: item.id, rank: rank + 1 }],
      score: item.score,
    }
    evidences.push(ev)
    byTarget.set(targetId, ev)
  }
  const top = vec.length > 0 ? vec[0].score : 0
  return {
    evidences,
    subChunkIds: fused.slice(0, config.recallPerChannel).map((x) => x.id),
    topSimilarity: top,
    debug: { terms, vectorTop: vec.map((x) => x.id), keywordTop: kw.ranked.map((x) => x.id), keywordMode: kw.mode, truncated: false, chars: evidences.reduce((s, e) => s + e.text.length, 0) },
  }
}
