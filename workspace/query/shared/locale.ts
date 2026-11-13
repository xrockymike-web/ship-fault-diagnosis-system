/**
 * 语言数据层：中文↔英文标签表 + 证据包/图谱全貌的读时本地化。
 * 只按 id 查表，不调 API、不碰检索逻辑。
 */
import type { EvidenceBundle } from './types'
import { openRo } from './sqlite'

export type Locale = 'zh' | 'en'

interface Maps { name: Map<string, string>; type: Map<string, string>; rel: Map<string, string> }

export function loadMaps(graphDb: string): Maps {
  const db = openRo(graphDb)
  const name = new Map<string, string>()
  for (const r of db.prepare('SELECT name, name_en FROM entities WHERE name_en IS NOT NULL').iterate() as Iterable<Record<string, unknown>>) {
    name.set(String(r.name), String(r.name_en))
  }
  const type = new Map<string, string>()
  const rel = new Map<string, string>()
  try {
    for (const r of db.prepare("SELECT kind, zh, en FROM labels_en WHERE en IS NOT NULL AND en <> ''").iterate() as Iterable<Record<string, unknown>>) {
      const k = String(r.kind)
      if (k === 'entity_type') type.set(String(r.zh), String(r.en))
      else if (k === 'relation') rel.set(String(r.zh), String(r.en))
    }
  } catch { /* labels_en 不存在时保持空表 */ }
  return { name, type, rel }
}

const sortedEntries = (m: Map<string, string>) => [...m.entries()].sort((a, b) => b[0].length - a[0].length)

function translateStr(s: string, maps: Maps): string {
  if (!s) return s
  if (maps.rel.has(s)) return maps.rel.get(s)!
  if (maps.type.has(s)) return maps.type.get(s)!
  if (maps.name.has(s)) return maps.name.get(s)!
  let out = s
  for (const [zh, en] of sortedEntries(maps.name)) if (out.includes(zh)) out = out.split(zh).join(en)
  for (const [zh, en] of sortedEntries(maps.rel)) if (out.includes(zh)) out = out.split(zh).join(en)
  for (const [zh, en] of sortedEntries(maps.type)) if (out.includes(zh)) out = out.split(zh).join(en)
  return out
}

function deepMap(v: unknown, maps: Maps): unknown {
  if (typeof v === 'string') return translateStr(v, maps)
  if (Array.isArray(v)) return v.map((x) => deepMap(x, maps))
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = deepMap(val, maps)
    return o
  }
  return v
}


/**
 * 读时本地化：证据包只存 id（chunkId / entityId / relation），显示文字按当前语言现取。
 * 纯查表、零 API、离线可用；找不到 id（用户自建文本）时保留原文。
 */
export function localizeBundle<T>(bundle: T, locale: Locale, paths: { chunkDb: string; graphDb: string }): T {
  if (!bundle || typeof bundle !== 'object') return bundle
  const cdb = openRo(paths.chunkDb)
  const gdb = openRo(paths.graphDb)
  const chunkStmt = cdb.prepare('SELECT text, text_en FROM chunks WHERE id = ?')
  const entStmt = gdb.prepare('SELECT name, name_en, type FROM entities WHERE id = ?')
  const rel = new Map<string, string>()
  const relRev = new Map<string, string>()
  const typ = new Map<string, string>()
  const typRev = new Map<string, string>()
  try {
    for (const r of gdb.prepare('SELECT kind, zh, en FROM labels_en').iterate() as Iterable<Record<string, unknown>>) {
      const kind = String(r.kind), zh = String(r.zh), en = String(r.en ?? '')
      if (!en) continue
      if (kind === 'relation') { rel.set(zh, en); relRev.set(en, zh) }
      else { typ.set(zh, en); typRev.set(en, zh) }
    }
  } catch { /* 没有 labels_en 时保持原样 */ }
  const pick = (zh: unknown, en: unknown): string => {
    const a = typeof zh === 'string' ? zh : ''
    const b = typeof en === 'string' ? en : ''
    return locale === 'en' ? (b || a) : (a || b)
  }
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk)
    if (!v || typeof v !== 'object') return v
    const src = v as Record<string, unknown>
    const o: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(src)) o[k] = walk(val)
    if (typeof src.chunkId === 'string') {
      const row = chunkStmt.get(src.chunkId) as Record<string, unknown> | undefined
      if (row) {
        const t = pick(row.text, row.text_en)
        if (t) o.text = t
      }
    }
    if (typeof src.entityId === 'string') {
      const row = entStmt.get(src.entityId) as Record<string, unknown> | undefined
      if (row) {
        const n = pick(row.name, row.name_en)
        if (n) o.name = n
        const rawType = typeof src.type === 'string' ? src.type : String(row.type ?? '')
        const zhType = typRev.get(rawType) ?? rawType
        o.type = locale === 'en' ? (typ.get(zhType) ?? rawType) : zhType
      }
    }
    if (typeof src.relation === 'string') {
      const m = locale === 'en' ? rel : relRev
      o.relation = m.get(src.relation) ?? src.relation
    }
    if (typeof src.from === 'string' && typeof src.to === 'string') {
      for (const [idKey, nameKey] of [['from', 'fromName'], ['to', 'toName']] as const) {
        const id = src[idKey]
        if (typeof id !== 'string') continue
        const row = entStmt.get(id) as Record<string, unknown> | undefined
        if (row) {
          const n = pick(row.name, row.name_en)
          if (n) o[nameKey] = n
        }
      }
    }
    return o
  }
  return walk(bundle) as T
}
/** 图谱全貌（graph.overview）英文化：实体名/类型/关系名一并映射 */
export function mapGraphOverviewEn<T>(data: T, graphDb: string): T {
  return deepMap(data, loadMaps(graphDb)) as T
}

/** 把中文 bundle 映射成英文：文本用 text_en，图谱按名称/标签映射 */
export function mapBundleEn(bundle: EvidenceBundle, paths: { chunkDb: string; graphDb: string }): EvidenceBundle {
  const maps = loadMaps(paths.graphDb)
  const db = openRo(paths.chunkDb)
  const stmt = db.prepare('SELECT text_en FROM chunks WHERE id = ?')
  const text = {
    evidences: bundle.text.evidences.map((e) => {
      const row = stmt.get(e.chunkId) as Record<string, unknown> | undefined
      const en = row && typeof row.text_en === 'string' ? String(row.text_en) : ''
      return { ...e, text: en || e.text, title: e.title ? translateStr(e.title, maps) : e.title, sourceNote: e.sourceNote }
    }),
  }
  const graph = deepMap(bundle.graph, maps) as EvidenceBundle['graph']
  const diagnostics = deepMap(bundle.diagnostics, maps) as EvidenceBundle['diagnostics']
  const notes = bundle.notes.map((n) => translateStr(n, maps))
  return { ...bundle, text, graph, diagnostics, notes }
}

// ---------------------------------------------------------------------------
// 英文提示词装配（六段同构；不依赖中文 evidence-prompt 的硬编码标签）
// ---------------------------------------------------------------------------
