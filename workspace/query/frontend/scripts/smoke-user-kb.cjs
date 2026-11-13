#!/usr/bin/env node
/**
 * U1/U3 冒烟：用户知识库存储层 + 向量化（qa-core/user-kb.ts 的构建产物）
 *
 * 用法：node scripts/smoke-user-kb.cjs       （先 npm run build）
 * 纪律：**只跑临时 dataDir**（data/runtime/u1_smoke），**绝不碰真实 user_data**。
 * 判据：F1 幂等 / F2 CRUD+id 前缀 / F3 越界与悬空被拒 / F4 同名 warning / F5 revision / N4 日志无正文 / N5 目录白名单
 * ⚠️ U3 起 saveUserText / saveUserEntity 是 **async**（保存时要调嵌入服务）——必须 await。
 */
const { mkdirSync, rmSync, readFileSync, readdirSync, existsSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { createHash } = require('node:crypto')

const ROOT = resolve(__dirname, '..', '..', '..', '..')   // scripts → frontend → query → workspace → 根
const BUILT = join(ROOT, 'workspace', 'bin', 'resources', 'app', 'qa-core', 'user-kb.js')
if (!existsSync(BUILT)) {
  console.error('[kb] 找不到构建产物：' + BUILT + '\n     先跑 cd workspace/query/frontend && npm run build')
  process.exit(2)
}
const kb = require(BUILT)

const scratch = join(ROOT, 'workspace', 'data', 'runtime', 'u1_smoke')
const graphDb = join(ROOT, 'workspace', 'data', 'vector-index', 'graph', 'graph.sqlite')
rmSync(scratch, { recursive: true, force: true })
mkdirSync(join(scratch, 'logs'), { recursive: true })
const paths = { dataDir: scratch, logsDir: join(scratch, 'logs'), runtimeDir: scratch, mode: 'development' }

let pass = 0
let fail = 0
const ck = (cond, name, extra) => {
  if (cond) { pass++; console.log('  PASS ' + name + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')) }
}
const ckErr = (name, fn, wantCode) => {
  try { fn(); fail++; console.log('  FAIL ' + name + '（本应报错）') }
  catch (e) { const ok = !wantCode || e.code === wantCode; ok ? pass++ : fail++; console.log((ok ? '  PASS ' : '  FAIL ') + name + '  code=' + e.code) }
}
/** ⚠️ U3 起 saveUserText / saveUserEntity 是 async —— 校验它们要 await，否则 reject 抓不到 */
const ckErrA = async (name, fn, wantCode) => {
  try { await fn(); fail++; console.log('  FAIL ' + name + '（本应报错）') }
  catch (e) { const ok = !wantCode || e.code === wantCode; ok ? pass++ : fail++; console.log((ok ? '  PASS ' : '  FAIL ') + name + '  code=' + e.code) }
}
const hash = (f) => createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 16)

/**
 * 🔴 内置实体号**动态取**，不硬编码。
 *   教训（2026-10-17 数据脱钩）：本脚本原先写死旧实体号；编号换成 E-#### 后
 *   冒烟直接报 endpoint-not-found —— 测试因"数据换了标签"而失败，属假失败。
 *   `kb` 本身已带 sqlite，这里直接用只读查询取第一个内置实体号。
 */
const builtinEntityId = (() => {
  const { DatabaseSync } = require('node:sqlite')
  const d = new DatabaseSync(graphDb, { readOnly: true })
  const r = d.prepare('SELECT id FROM entities ORDER BY id LIMIT 1').get()
  d.close()
  if (!r || !r.id) throw new Error('取不到内置实体号（graph 库为空？）：' + graphDb)
  return r.id
})()

/** 假的 embedder：不发网络，返回确定性向量（冒烟只验"有没有建向量"，不验语义） */
const fakeEmbedder = {
  modelId: kb.USER_VECTOR_MODEL,
  embed: async (texts) => texts.map((t, i) => {
    const v = new Array(kb.USER_VECTOR_DIM).fill(0)
    v[(t.length + i) % kb.USER_VECTOR_DIM] = 1
    return v
  }),
}

async function main() {
  console.log('=== 用户知识库冒烟（临时 dataDir：' + scratch.replace(ROOT, '') + '）===')
  kb.openUserKb(paths)
  const dbFile = kb.userKbPath(paths)
  ck(existsSync(dbFile), 'F1 建库 + schema', 'schema=' + kb.USER_KB_SCHEMA_VERSION + ' / 类型 ' + kb.ENTITY_TYPES.length + ' 类')
  ck(kb.ENTITY_TYPES.length === 7, 'F1 本体 7 类实体')
  const h0 = hash(dbFile)
  kb.openUserKb(paths)
  ck(hash(dbFile) === h0, 'F1 二次打开幂等（哈希不变）', h0)

  // 没有 embedder：应保存成功但**标待索引**（不静默）
  const t0 = await kb.saveUserText(paths, { title: '无模型', text: '没有嵌入服务时保存' }, null)
  const s0 = kb.listUserKb(paths, graphDb)
  ck(t0.id === 'UT-0001' && s0.texts[0].indexed === false && s0.pendingIndex >= 1, 'U3 无 embedder → 待索引', JSON.stringify({ id: t0.id, indexed: s0.texts[0].indexed, pending: s0.pendingIndex }))
  ck(t0.warnings.length > 0, 'U3 明确回 warning', JSON.stringify(t0.warnings[0] || '').slice(0, 60))

  const t1 = await kb.saveUserText(paths, { title: '接线说明', text: '冒烟特征串 SMOKE-7A1 某型主机遥控板接线', sourceNote: '自记' }, fakeEmbedder)
  ck(t1.id === 'UT-0002' && typeof t1.revision === 'number', 'F2 文本 id/revision', JSON.stringify(t1))
  const e1 = await kb.saveUserEntity(paths, graphDb, { name: '某型主机遥控板', type: '船舶装备', aliases: ['遥控板', 'RCU'] }, fakeEmbedder)
  ck(e1.id === 'U-0001', 'F2 实体 id', e1.id)
  const tr1 = kb.saveUserTriple(paths, graphDb, { subjectId: e1.id, predicate: '包含', objectId: builtinEntityId })
  ck(tr1.id === 'UR-0001', 'F2 三元组 id（自建 + 内置两端）', tr1.id + ' 内置端=' + builtinEntityId)

  const withVec = kb.listUserKb(paths, graphDb)
  ck(withVec.entities[0].indexed === true && withVec.texts[1].indexed === true, 'U3 有 embedder → 已索引', JSON.stringify({ e: withVec.entities[0].indexed, t: withVec.texts[1].indexed, pending: withVec.pendingIndex }))

  const rk = await kb.reindexUserKb(paths, fakeEmbedder)
  ck(rk.pending === 0 && typeof rk.embedded === 'number', 'U3 重建索引 → 无待索引', JSON.stringify(rk))

  await ckErrA('F3 类型越界被拒', () => kb.saveUserEntity(paths, graphDb, { name: 'X', type: '瞎写' }, fakeEmbedder), 'type-not-in-ontology')
  ckErr('F3 关系越界被拒', () => kb.saveUserTriple(paths, graphDb, { subjectId: e1.id, predicate: '瞎写', objectId: builtinEntityId }), 'relation-not-in-ontology')
  ckErr('F3 端点悬空被拒', () => kb.saveUserTriple(paths, graphDb, { subjectId: e1.id, predicate: '包含', objectId: 'NOPE-1' }), 'endpoint-not-found')
  await ckErrA('F3 空正文被拒', () => kb.saveUserText(paths, { text: '  ' }, null), 'empty-text')
  await ckErrA('F3 空名被拒', () => kb.saveUserEntity(paths, graphDb, { name: ' ', type: '船舶装备' }, null), 'empty-name')
  ckErr('F3 删不存在被拒', () => kb.deleteUserEntity(paths, 'U-9999'), 'not-found')

  const e2 = await kb.saveUserEntity(paths, graphDb, { name: '故障树', type: '故障原因' }, fakeEmbedder)
  ck(e2.warnings.length > 0, 'F4 与内置同名的 warning', JSON.stringify(e2.warnings).slice(0, 70))

  const s1 = kb.listUserKb(paths, graphDb)
  ck(s1.texts.length === 2 && s1.entities.length === 2 && s1.triples.length === 1, 'F2 list 计数', JSON.stringify({ t: s1.texts.length, e: s1.entities.length, tr: s1.triples.length }))
  ck(s1.entityTypes.length === 7 && s1.relationTypes.length === 11, 'F2 本体清单', '实体 ' + s1.entityTypes.length + ' / 关系 ' + s1.relationTypes.length)

  const del = kb.deleteUserEntity(paths, e1.id)
  ck(del.warnings.length > 0 && del.removed === 2, 'F2 删实体级联删边', JSON.stringify(del))
  ck(kb.deleteUserText(paths, t1.id).removed === 1, 'F2 删文本')

  const vecs = kb.loadUserVectors(paths)
  ck(vecs.texts.size + vecs.entities.size >= 1, 'U4 向量可读出', 'text ' + vecs.texts.size + ' / entity ' + vecs.entities.size)

  const log = existsSync(join(scratch, 'logs', 'app.log')) ? readFileSync(join(scratch, 'logs', 'app.log'), 'utf8') : ''
  ck(!log.includes('SMOKE-7A1'), 'N4 日志不含用户正文', log.trim().split('\n').length + ' 行')
  const files = readdirSync(join(scratch, 'user_data')).sort()
  ck(files.every((f) => ['user-kb.sqlite', 'user-kb.sqlite-wal', 'user-kb.sqlite-shm', 'README.txt', '.gitkeep'].includes(f)), 'N5 user_data 内文件名白名单', JSON.stringify(files))

  console.log('')
  console.log('RESULT ' + (fail === 0 ? 'OK（' + pass + ' 项全 PASS）' : 'FAIL（' + fail + ' 项）'))
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('[kb] 冒烟异常：', e); process.exit(1) })
