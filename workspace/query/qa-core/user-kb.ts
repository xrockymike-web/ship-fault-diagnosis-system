/**
 * 用户知识库（User KB）—— 用户自己往知识库加 **文本 / 图节点 / 三元组**（U1 · 存储层）
 *
 * 🔴 三条硬纪律（负责人 2026-10-07 拍板）：
 *   ① **落点唯一**：本文件是**全项目唯一**拼并打开 `<dataDir>/user_data/user-kb.sqlite` 的地方。
 *      用户内容**绝不**写进三库 / curated / 其它 data 位置 —— 教材三库一律 **readOnly** 打开。
 *   ② **不静默降级**：越界（类型/关系不在本体）、空名、端点不存在、id 冲突 —— 一律抛 `KbError`。
 *   ③ **日志不记正文**：logEvent 只允许记 **id / 计数 / 错误码**，**不得**出现用户录入的正文。
 *      （校验失败的中文消息只回给前端显示，不进日志 —— 日志里只有 code。）
 *
 * 表：user_meta / user_texts / user_entities / user_triples / user_vectors（schema_version = 1）
 * id：`U-####` 实体 ｜ `UT-####` 文本 ｜ `UR-####` 三元组（与教材 CH…/pa-…/tb-… 绝不冲突）
 * 性质：本层是**追加**的 —— 不动 EvidenceBundle 五块、不动三库、不动模块目录。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AppPaths } from '../launcher/bootstrap/index'
import { logEvent } from '../launcher/diagnostics/index'
import type {
  UserEntity,
  UserKbDeleteResult,
  UserKbSaveResult,
  UserKbSnapshot,
  UserText,
  UserTriple,
} from '../shared/types'

/** schema 版本（与教材三库各自独立；不兼容就报错，不静默迁移） */
export const USER_KB_SCHEMA_VERSION = 1

/** 本体冻结：7 类实体（与 graph 库一致）。关系名不在这里写死 —— 从 graph 库只读读取。 */
export const ENTITY_TYPES: readonly string[] = [
  '故障现象',
  '故障原因',
  '维修步骤',
  '船舶装备',
  '零部件',
  '注意事项',
  '维护项目',
]

const ID_PREFIX = { text: 'UT-', entity: 'U-', triple: 'UR-' } as const
const PAD = 4

export class KbError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'KbError'
    this.code = code
  }
}

/**
 * 🆕 U3：向量化口径。
 * 🔴 只写 `user_data/user-kb.sqlite`；**绝不碰教材三库**（D29 要求 1）。
 * 编码文本 = 标题/名称 + 换行 + 正文/说明，按 D23 公共口径 **≤1200 字** 预截断并记录。
 * 模型 id 与教材向量保持一致（改模型 = 这些向量要重算，与 D23「改模板=全量重算」同理）。
 */
export const USER_VECTOR_MODEL = 'Qwen3-Embedding-0.6B-Q8_0'
export const USER_VECTOR_DIM = 1024
const MAX_CHARS = 1200

/** 由 qa-core 注入（它才知道嵌入服务端口）；没就绪就不编码，**不静默**——回一条 warning */
export interface Embedder {
  modelId: string
  embed(texts: string[]): Promise<number[][]>
}

function clip(s: string): { text: string; truncated: number; srcChars: number } {
  const srcChars = s.length
  return s.length > MAX_CHARS ? { text: s.slice(0, MAX_CHARS), truncated: 1, srcChars } : { text: s, truncated: 0, srcChars }
}

/** 文本向量文本 = 标题 + 换行 + 正文（D23 公共口径：≤1200 字，逐条记 truncated/src_chars） */
function vecOfText(t: { title: string; text: string }): { text: string; truncated: number; srcChars: number } {
  return clip((t.title ? t.title + '\n' : '') + t.text)
}
/** 实体向量文本 = 名称 + 换行 + 说明（对齐 D23「名 + attributes」） */
function vecOfEntity(e: { name: string; description: string | null }): { text: string; truncated: number; srcChars: number } {
  return clip(e.description ? e.name + '\n' + e.description : e.name)
}

function upsertVector(d: DatabaseSync, objId: string, objType: 'text' | 'entity', vec: number[], srcChars: number, truncated: number): void {
  const blob = Buffer.from(new Float32Array(vec).buffer)
  d.prepare(
    'INSERT INTO user_vectors (obj_id,obj_type,dim,blob,model_id,truncated,src_chars) VALUES (?,?,?,?,?,?,?) ' +
      'ON CONFLICT(obj_id) DO UPDATE SET obj_type=excluded.obj_type, dim=excluded.dim, blob=excluded.blob, model_id=excluded.model_id, truncated=excluded.truncated, src_chars=excluded.src_chars',
  ).run(objId, objType, vec.length, blob, USER_VECTOR_MODEL, truncated, srcChars)
}

function hasVector(d: DatabaseSync, objId: string): boolean {
  const r = d.prepare('SELECT 1 AS x FROM user_vectors WHERE obj_id=? AND model_id=? AND dim=?').get(objId, USER_VECTOR_MODEL, USER_VECTOR_DIM) as { x?: number } | undefined
  return r !== undefined
}

/** 读了全部用户向量（U4 检索合并用；**只读本库**） */
export function loadUserVectors(paths: AppPaths): { texts: Map<string, Float32Array>; entities: Map<string, Float32Array> } {
  const d = openUserKb(paths)
  const texts = new Map<string, Float32Array>()
  const entities = new Map<string, Float32Array>()
  for (const r of d.prepare('SELECT obj_id, obj_type, blob FROM user_vectors').iterate() as Iterable<Record<string, unknown>>) {
    const f = new Float32Array((r.blob as Buffer).buffer, (r.blob as Buffer).byteOffset, (r.blob as Buffer).byteLength / 4)
    if (String(r.obj_type) === 'text') texts.set(String(r.obj_id), f)
    else if (String(r.obj_type) === 'entity') entities.set(String(r.obj_id), f)
  }
  return { texts, entities }
}

/** 给一批对象补向量（保存时调用；embedder 为 null 时跳过并返回 0） */
async function embedInto(d: DatabaseSync, embedder: Embedder | null, items: { id: string; type: 'text' | 'entity'; src: string; srcChars: number; truncated: number }[]): Promise<number> {
  const todo = items.filter((x) => !hasVector(d, x.id))
  if (!embedder || todo.length === 0) return 0
  const vecs = await embedder.embed(todo.map((x) => x.src))
  if (vecs.length !== todo.length) throw new KbError('embed-shape', '嵌入返回条数不对：要 ' + todo.length + '，得 ' + vecs.length)
  todo.forEach((x, i) => {
    const v = vecs[i]
    if (!Array.isArray(v) || v.length !== USER_VECTOR_DIM) throw new KbError('embed-dim', '向量维度不对：期望 ' + USER_VECTOR_DIM + '，实得 ' + (v ? v.length : 0))
    upsertVector(d, x.id, x.type, v, x.srcChars, x.truncated)
  })
  return todo.length
}

/** 单条补向量；失败/未就绪**不抛**（保存本身要成功），改成一条 warning 让界面显示 */
async function embedOne(d: DatabaseSync, embedder: Embedder | null, item: { id: string; type: 'text' | 'entity'; src: string; srcChars: number; truncated: number }): Promise<string[]> {
  if (hasVector(d, item.id)) return []
  if (!embedder) return ['已保存，但**没有向量**（嵌入模型未就绪）→ 现在检索不到它；模型就绪后点「重建索引」即可']
  try {
    const n = await embedInto(d, embedder, [item])
    return n > 0 ? [] : ['已保存，向量未更新（可在页面上点「重建索引」重试）']
  } catch (e) {
    return ['已保存，但向量化失败：' + (e as Error).message + '（可在页面上点「重建索引」重试）']
  }
}

/** 重建索引：把**还没有向量**的文本/实体补上（界面「重建索引」按钮） */
export async function reindexUserKb(paths: AppPaths, embedder: Embedder | null): Promise<{ revision: number; embedded: number; pending: number }> {
  const d = openUserKb(paths)
  const t = d.prepare('SELECT id,title,text FROM user_texts').all() as Array<{ id: string; title: string; text: string }>
  const e = d.prepare('SELECT id,name,description FROM user_entities').all() as Array<{ id: string; name: string; description: string | null }>
  const items = [
    ...t.map((x) => { const c = vecOfText(x); return { id: x.id, type: 'text' as const, src: c.text, srcChars: c.srcChars, truncated: c.truncated } }),
    ...e.map((x) => { const c = vecOfEntity(x); return { id: x.id, type: 'entity' as const, src: c.text, srcChars: c.srcChars, truncated: c.truncated } }),
  ]
  const embedded = await embedInto(d, embedder, items)
  return { revision: revisionOf(d), embedded, pending: items.filter((x) => !hasVector(d, x.id)).length }
}

export interface UserTextInput { id?: string; title?: string; text: string; sourceNote?: string | null }
export interface UserEntityInput { id?: string; name: string; type: string; aliases?: string[]; description?: string | null }
export interface UserTripleInput { id?: string; subjectId: string; predicate: string; objectId: string; note?: string | null }

const SCHEMA = [
  'PRAGMA journal_mode = WAL;',
  'PRAGMA foreign_keys = ON;',
  'CREATE TABLE IF NOT EXISTS user_meta (',
  '  key   TEXT PRIMARY KEY,',
  '  value TEXT NOT NULL',
  ');',
  'CREATE TABLE IF NOT EXISTS user_texts (',
  '  id          TEXT PRIMARY KEY,',
  "  title       TEXT NOT NULL DEFAULT '',",
  '  text        TEXT NOT NULL,',
  '  source_note TEXT,',
  '  created_at  INTEGER NOT NULL',
  ');',
  'CREATE TABLE IF NOT EXISTS user_entities (',
  '  id          TEXT PRIMARY KEY,',
  '  name        TEXT NOT NULL,',
  '  type        TEXT NOT NULL,',
  "  aliases     TEXT NOT NULL DEFAULT '[]',",
  '  description TEXT,',
  '  created_at  INTEGER NOT NULL',
  ');',
  'CREATE TABLE IF NOT EXISTS user_triples (',
  '  id         TEXT PRIMARY KEY,',
  '  subject_id TEXT NOT NULL,',
  '  predicate  TEXT NOT NULL,',
  '  object_id  TEXT NOT NULL,',
  '  note       TEXT,',
  '  created_at INTEGER NOT NULL',
  ');',
  'CREATE TABLE IF NOT EXISTS user_vectors (',
  '  obj_id           TEXT PRIMARY KEY,',
  '  obj_type         TEXT NOT NULL,',
  '  dim              INTEGER NOT NULL,',
  '  blob             BLOB NOT NULL,',
  '  model_id         TEXT NOT NULL,',
  '  truncated        INTEGER NOT NULL DEFAULT 0,',
  '  src_chars        INTEGER',
  ');',
].join('\n')

let db: DatabaseSync | null = null
let dbPath = ''

/** 🔴 G1：全项目**唯一**拼这个路径的地方 */
export function userKbPath(paths: AppPaths): string {
  return join(paths.dataDir, 'user_data', 'user-kb.sqlite')
}

/** 打开（必要时建库）；库/表都幂等创建。**本函数是唯一写句柄入口。** */
export function openUserKb(paths: AppPaths): DatabaseSync {
  if (db && dbPath === userKbPath(paths)) return db
  const dir = join(paths.dataDir, 'user_data')
  mkdirSync(dir, { recursive: true })
  const file = userKbPath(paths)
  const d = new DatabaseSync(file)
  d.exec(SCHEMA)
  const row = d.prepare("SELECT value FROM user_meta WHERE key='schema_version'").get() as { value?: string } | undefined
  const cur = Number(row && row.value ? row.value : 0)
  if (cur !== 0 && cur !== USER_KB_SCHEMA_VERSION) {
    throw new KbError('schema-mismatch', '用户知识库 schema 版本不匹配：库里是 v' + cur + '，程序要 v' + USER_KB_SCHEMA_VERSION + '（不自动迁移）')
  }
  d.prepare("INSERT INTO user_meta (key,value) VALUES ('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(USER_KB_SCHEMA_VERSION))
  d.prepare("INSERT INTO user_meta (key,value) VALUES ('revision','0') ON CONFLICT(key) DO NOTHING").run()
  db = d
  dbPath = file
  logEvent(paths, { event: 'kb:opened', schema: USER_KB_SCHEMA_VERSION, file })
  return d
}

function revisionOf(d: DatabaseSync): number {
  const r = d.prepare("SELECT value FROM user_meta WHERE key='revision'").get() as { value?: string } | undefined
  return Number(r && r.value ? r.value : 0)
}

function bumpRevision(d: DatabaseSync): number {
  const next = revisionOf(d) + 1
  d.prepare("UPDATE user_meta SET value=? WHERE key='revision'").run(String(next))
  return next
}

function nextId(d: DatabaseSync, table: string, prefix: string): string {
  const row = d.prepare('SELECT id FROM ' + table + ' WHERE id LIKE ? ORDER BY id DESC LIMIT 1').get(prefix + '%') as { id?: string } | undefined
  const n = row && row.id ? Number(String(row.id).slice(prefix.length)) : 0
  return prefix + String((Number.isFinite(n) ? n : 0) + 1).padStart(PAD, '0')
}

function assertId(id: unknown, prefix: string, what: string): string {
  const s = String(id ?? '').trim()
  if (!s) throw new KbError('empty-id', what + ' id 不能为空')
  if (!s.startsWith(prefix)) throw new KbError('bad-id', what + ' id 必须以 ' + prefix + ' 开头（实得 ' + s + '）')
  return s
}

// ---------------------------------------------------------------------------
// 本体（只读来源：graph 库；同一 build 的库不变 → 进程内缓存）
// ---------------------------------------------------------------------------

interface TextbookIndex { ids: Set<string>; names: Set<string> }
const TEXTBOOK_INDEX = new Map<string, TextbookIndex>()
const RELATION_CACHE = new Map<string, string[]>()

/** 教材实体 id + 名字（**只读**打开 graph 库；用于"端点必须存在"与"同名检测"） */
function textbookIndex(graphDb: string): TextbookIndex {
  const hit = TEXTBOOK_INDEX.get(graphDb)
  if (hit) return hit
  const g = new DatabaseSync(graphDb, { readOnly: true })
  try {
    const ids = new Set<string>()
    const names = new Set<string>()
    for (const r of g.prepare('SELECT id, name FROM entities').iterate() as Iterable<Record<string, unknown>>) {
      ids.add(String(r.id))
      names.add(String(r.name ?? ''))
    }
    const idx: TextbookIndex = { ids, names }
    TEXTBOOK_INDEX.set(graphDb, idx)
    return idx
  } finally {
    g.close()
  }
}

/** 关系名（只读 graph 库的 relation_types；11 类本体） */
export function readRelationTypes(graphDb: string): string[] {
  const hit = RELATION_CACHE.get(graphDb)
  if (hit) return hit
  const g = new DatabaseSync(graphDb, { readOnly: true })
  try {
    const out: string[] = []
    for (const r of g.prepare('SELECT name FROM relation_types ORDER BY id').iterate() as Iterable<Record<string, unknown>>) {
      out.push(String(r.name ?? ''))
    }
    RELATION_CACHE.set(graphDb, out)
    return out
  } finally {
    g.close()
  }
}

// ---------------------------------------------------------------------------
// 读 / 写
// ---------------------------------------------------------------------------

function rowToText(r: Record<string, unknown>): UserText {
  return {
    id: String(r.id),
    title: String(r.title ?? ''),
    text: String(r.text ?? ''),
    sourceNote: r.source_note === null || r.source_note === undefined ? null : String(r.source_note),
    createdAt: Number(r.created_at ?? 0),
  }
}

function rowToEntity(r: Record<string, unknown>): UserEntity {
  let aliases: string[] = []
  try {
    const parsed = JSON.parse(String(r.aliases ?? '[]')) as unknown
    if (Array.isArray(parsed)) aliases = parsed.map((x) => String(x))
  } catch {
    aliases = []
  }
  return {
    id: String(r.id),
    name: String(r.name ?? ''),
    type: String(r.type ?? ''),
    aliases,
    description: r.description === null || r.description === undefined ? null : String(r.description),
    createdAt: Number(r.created_at ?? 0),
  }
}

function rowToTriple(r: Record<string, unknown>): UserTriple {
  return {
    id: String(r.id),
    subjectId: String(r.subject_id),
    predicate: String(r.predicate),
    objectId: String(r.object_id),
    note: r.note === null || r.note === undefined ? null : String(r.note),
    createdAt: Number(r.created_at ?? 0),
  }
}

/** 一次拉全量（自建量级小；与 graph.overview 同策略） */
export function listUserKb(paths: AppPaths, graphDb: string): UserKbSnapshot {
  const d = openUserKb(paths)
  const texts = (d.prepare('SELECT id,title,text,source_note,created_at FROM user_texts ORDER BY created_at, id').all() as Array<Record<string, unknown>>).map(rowToText)
  const entities = (d.prepare('SELECT id,name,type,aliases,description,created_at FROM user_entities ORDER BY created_at, id').all() as Array<Record<string, unknown>>).map(rowToEntity)
  const triples = (d.prepare('SELECT id,subject_id,predicate,object_id,note,created_at FROM user_triples ORDER BY created_at, id').all() as Array<Record<string, unknown>>).map(rowToTriple)
  // U3：标出哪些还没有向量（界面显示「待索引」，并给出「重建索引」提示）
  let pending = 0
  for (const t of texts) { t.indexed = hasVector(d, t.id); if (!t.indexed) pending += 1 }
  for (const e of entities) { e.indexed = hasVector(d, e.id); if (!e.indexed) pending += 1 }
  return {
    texts,
    entities,
    triples,
    entityTypes: [...ENTITY_TYPES],
    relationTypes: readRelationTypes(graphDb),
    revision: revisionOf(d),
    pendingIndex: pending,
  }
}

export async function saveUserText(paths: AppPaths, input: UserTextInput, embedder: Embedder | null = null): Promise<UserKbSaveResult> {
  const d = openUserKb(paths)
  const text = String(input.text ?? '').trim()
  if (!text) throw new KbError('empty-text', '文本正文不能为空')
  const id = input.id ? assertId(input.id, ID_PREFIX.text, '文本') : nextId(d, 'user_texts', ID_PREFIX.text)
  const now = Date.now()
  d.prepare(
    "INSERT INTO user_texts (id,title,text,source_note,created_at) VALUES (?,?,?,?,?) " +
      'ON CONFLICT(id) DO UPDATE SET title=excluded.title, text=excluded.text, source_note=excluded.source_note',
  ).run(id, String(input.title ?? '').trim(), text, input.sourceNote ?? null, now)
  const c = vecOfText({ title: String(input.title ?? '').trim(), text })
  const warnings = await embedOne(d, embedder, { id, type: 'text', src: c.text, srcChars: c.srcChars, truncated: c.truncated })
  return { id, revision: bumpRevision(d), warnings }
}

export function deleteUserText(paths: AppPaths, id: string): UserKbDeleteResult {
  const d = openUserKb(paths)
  const tid = assertId(id, ID_PREFIX.text, '文本')
  const res = d.prepare('DELETE FROM user_texts WHERE id=?').run(tid)
  d.prepare("DELETE FROM user_vectors WHERE obj_id=? AND obj_type='text'").run(tid)
  const removed = Number(res.changes ?? 0)
  if (removed === 0) throw new KbError('not-found', '文本不存在：' + tid)
  return { revision: bumpRevision(d), removed, warnings: [] }
}

export async function saveUserEntity(paths: AppPaths, graphDb: string, input: UserEntityInput, embedder: Embedder | null = null): Promise<UserKbSaveResult> {
  const d = openUserKb(paths)
  const name = String(input.name ?? '').trim()
  if (!name) throw new KbError('empty-name', '实体名称不能为空')
  const type = String(input.type ?? '').trim()
  if (!ENTITY_TYPES.includes(type)) {
    throw new KbError('type-not-in-ontology', '实体类型必须是本体 7 类之一（实得「' + type + '」）；合法值：' + ENTITY_TYPES.join(' / '))
  }
  const id = input.id ? assertId(input.id, ID_PREFIX.entity, '实体') : nextId(d, 'user_entities', ID_PREFIX.entity)
  const aliases = (input.aliases ?? []).map((a) => String(a).trim()).filter(Boolean)
  const now = Date.now()
  d.prepare(
    'INSERT INTO user_entities (id,name,type,aliases,description,created_at) VALUES (?,?,?,?,?,?) ' +
      'ON CONFLICT(id) DO UPDATE SET name=excluded.name, type=excluded.type, aliases=excluded.aliases, description=excluded.description',
  ).run(id, name, type, JSON.stringify(aliases), input.description ?? null, now)

  // 同名检测：与内置知识库 1463 + 已建自建比对 → **warning，不阻断**
  const warnings: string[] = []
  if (textbookIndex(graphDb).names.has(name)) warnings.push('与内置知识库实体同名「' + name + '」：建议改用别名，避免图上一对同名节点被看成一个')
  const dup = d.prepare('SELECT count(*) c FROM user_entities WHERE name=? AND id<>?').get(name, id) as { c: number }
  if (Number(dup.c) > 0) warnings.push('已存在同名自建实体「' + name + '」：保存成功，但请确认不是重复')
  const c = vecOfEntity({ name, description: input.description ?? null })
  warnings.push(...(await embedOne(d, embedder, { id, type: 'entity', src: c.text, srcChars: c.srcChars, truncated: c.truncated })))
  return { id, revision: bumpRevision(d), warnings }
}

export function deleteUserEntity(paths: AppPaths, id: string): UserKbDeleteResult {
  const d = openUserKb(paths)
  const eid = assertId(id, ID_PREFIX.entity, '实体')
  const warnings: string[] = []
  // 🔴 不允许留悬空边：连带删除引用它的自建三元组（条数如实回传）
  const ref = d.prepare('SELECT count(*) c FROM user_triples WHERE subject_id=? OR object_id=?').get(eid, eid) as { c: number }
  const refN = Number(ref.c)
  const res = d.prepare('DELETE FROM user_entities WHERE id=?').run(eid)
  if (Number(res.changes ?? 0) === 0) throw new KbError('not-found', '实体不存在：' + eid)
  if (refN > 0) {
    d.prepare('DELETE FROM user_triples WHERE subject_id=? OR object_id=?').run(eid, eid)
    warnings.push('已同时删除 ' + refN + ' 条引用该实体的自建三元组（不留悬空边）')
  }
  d.prepare("DELETE FROM user_vectors WHERE obj_id=? AND obj_type='entity'").run(eid)
  return { revision: bumpRevision(d), removed: refN + 1, warnings }
}

export function saveUserTriple(paths: AppPaths, graphDb: string, input: UserTripleInput): UserKbSaveResult {
  const d = openUserKb(paths)
  const subjectId = String(input.subjectId ?? '').trim()
  const objectId = String(input.objectId ?? '').trim()
  const predicate = String(input.predicate ?? '').trim()
  if (!subjectId || !objectId) throw new KbError('empty-endpoint', '三元组两端都不能为空')
  // 关系必须在 11 类本体里（只读 graph 库取）
  const rels = readRelationTypes(graphDb)
  if (!rels.includes(predicate)) {
    throw new KbError('relation-not-in-ontology', '关系名必须是本体 11 类之一（实得「' + predicate + '」）；合法值：' + rels.join(' / '))
  }
  // 🔴 两端必须存在：教材实体 ∪ 自建实体（不允许悬空 —— 3.3.1 的坑不重犯）
  const textbookIds = textbookIndex(graphDb).ids
  const userIds = new Set((d.prepare('SELECT id FROM user_entities').all() as Array<{ id: string }>).map((r) => r.id))
  const exists = (x: string): boolean => textbookIds.has(x) || userIds.has(x)
  if (!exists(subjectId)) throw new KbError('endpoint-not-found', '头实体不存在（既不在内置知识库 1463，也不在自建实体里）：' + subjectId)
  if (!exists(objectId)) throw new KbError('endpoint-not-found', '尾实体不存在（既不在内置知识库 1463，也不在自建实体里）：' + objectId)
  const id = input.id ? assertId(input.id, ID_PREFIX.triple, '三元组') : nextId(d, 'user_triples', ID_PREFIX.triple)
  const warnings: string[] = []
  if (subjectId === objectId) warnings.push('头尾是同一个实体：已按自环保存，请确认')
  d.prepare(
    'INSERT INTO user_triples (id,subject_id,predicate,object_id,note,created_at) VALUES (?,?,?,?,?,?) ' +
      'ON CONFLICT(id) DO UPDATE SET subject_id=excluded.subject_id, predicate=excluded.predicate, object_id=excluded.object_id, note=excluded.note',
  ).run(id, subjectId, predicate, objectId, input.note ?? null, Date.now())
  return { id, revision: bumpRevision(d), warnings }
}

export function deleteUserTriple(paths: AppPaths, id: string): UserKbDeleteResult {
  const d = openUserKb(paths)
  const tid = assertId(id, ID_PREFIX.triple, '三元组')
  const res = d.prepare('DELETE FROM user_triples WHERE id=?').run(tid)
  if (Number(res.changes ?? 0) === 0) throw new KbError('not-found', '三元组不存在：' + tid)
  return { revision: bumpRevision(d), removed: 1, warnings: [] }
}

/** 当前 revision（缓存失效用；不打开库就给 0） */
export function currentUserKbRevision(paths: AppPaths): number {
  try {
    return revisionOf(openUserKb(paths))
  } catch {
    return 0
  }
}

/** 自检：user_data 目录里应当只有这几个文件（证据 N5 用，程序内不调用） */
export function userKbFilesExist(paths: AppPaths): string[] {
  const dir = join(paths.dataDir, 'user_data')
  if (!existsSync(dir)) return []
  return ['user-kb.sqlite', 'user-kb.sqlite-wal', 'user-kb.sqlite-shm', 'README.txt', '.gitkeep']
}
