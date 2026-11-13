/**
 * 目标 5 · 5.1 **每轮问答档案**（决策 **D26**，《技术总纲》§7.6.1）
 *
 * 定位：给负责人自己看的**离线操作记录本** —— 一轮问答里程序做的**全部操作**。
 *   · **不做界面入口**（普通用户与前端都不接触），自己进 data/runtime/qa-log/ 打开；
 *   · **H5**，一轮一个文件，**原始 JSON 内联**同一文件（人读 + 机器读一物两用）；
 *   · 子图 / 路径 / 树用**静态 SVG**（后台算好，页面内 0 行 JS）；
 *   · **16 块全量**；另追加跨轮统计 `turns.jsonl`；
 *   · 🔴 **写入旁路**：失败只记 app.log —— **不弹窗、不中断回答、不降级检索**。
 *
 * 🔴 与 §7.6 的边界：本产物**不属于**「正常日志」，**不受**「不保存完整知识正文」约束。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppPaths } from '../launcher/bootstrap/index'
import type { EvidenceBundle, GraphPath } from '../shared/types'
import { buildTree, classifyQuestion, type TNode } from '../shared/build-tree'

/** 配色照抄 V1 固定表（7 类实体 / 11 类关系）—— 与前端一致 */
const ENTITY_COLORS: Record<string, string> = {
  船舶装备: '#1E90FF', 故障现象: '#DC143C', 维修步骤: '#228B22', 故障原因: '#8A2BE2',
  维护项目: '#FF69B4', 注意事项: '#32CD32', 零部件: '#FF8C00',
}
const RELATION_COLORS: Record<string, string> = {
  包含: '#FF6B6B', 发生: '#4ECDC4', 导致: '#45B7D1', 对应: '#96CEB4', 使用: '#FECA57',
  适用: '#FF9FF3', 前置: '#54A0FF', 后续: '#5F27CD', 属于: '#00D2D3', 可预防: '#10AC84',
  需注意: '#FF9F43', 关联: '#576574',
}

export interface LoggingConfig {
  archive: { enabled: boolean; dir: string; retentionDays: number | null; maxTotalMB: number | null }
}

const DEFAULT_LOGGING: LoggingConfig = {
  archive: { enabled: true, dir: 'qa-log', retentionDays: null, maxTotalMB: null },
}

/** 读 config/logging/default.json；**缺文件不静默**（调用方据 `missing` 写 app.log，用文档默认值继续） */
export function loadLoggingConfig(paths: AppPaths): { cfg: LoggingConfig; missing: boolean; error: string | null } {
  const file = join(paths.configDir, 'logging', 'default.json')
  if (!existsSync(file)) return { cfg: DEFAULT_LOGGING, missing: true, error: null }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { archive?: Partial<LoggingConfig['archive']> }
    const a = raw.archive ?? {}
    return {
      cfg: {
        archive: {
          enabled: a.enabled !== false,
          dir: typeof a.dir === 'string' && a.dir ? a.dir : 'qa-log',
          retentionDays: typeof a.retentionDays === 'number' ? a.retentionDays : null,
          maxTotalMB: typeof a.maxTotalMB === 'number' ? a.maxTotalMB : null,
        },
      },
      missing: false,
      error: null,
    }
  } catch (err) {
    return { cfg: DEFAULT_LOGGING, missing: false, error: (err as Error).message }
  }
}

export interface TimelineStep { step: string; start: number; end: number; ms: number; note?: string }
export interface Judgment { input: string; rule: string; result: string; degraded?: boolean }

export interface TurnArchiveInput {
  question: string
  sessionId: string
  assistantMessageId: string
  userMessageId: string
  /** 本会话第几轮（1 起） */
  turnIndex: number
  isFirst: boolean
  stopped: boolean
  modelRegenerate: boolean
  startedAt: number
  finishedAt: number
  status: string
  error: string | null
  timeline: TimelineStep[]
  judgments: Judgment[]
  queryVector: number[] | null
  bundle: EvidenceBundle | null
  prompt: { system: string; user: string; systemChars: number; userChars: number; messageCount?: number } | null
  model: { port: number | null; params: Record<string, unknown> }
  sse: string[]
  answer: string
  appLogSince: string
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function esc(s: unknown): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function pad(n: number): string { return String(n).padStart(2, '0') }
function dayKey(d: Date): string { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) }
function hhmmss(d: Date): string { return pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) }
function num(v: number): string { return Number(v).toFixed(1) }
function cut(s: string, n: number): string { return s.length > n ? s.slice(0, n) + '…' : s }

// ---------------------------------------------------------------------------
// 静态 SVG（后台算好；页面里 0 行 JS）
// ---------------------------------------------------------------------------

interface XY { x: number; y: number; r: number; label: string; type: string }

function edgeSvg(a: XY, b: XY, color: string, arrow: boolean): string {
  const dx = b.x - a.x, dy = b.y - a.y
  const d = Math.sqrt(dx * dx + dy * dy) || 1
  const ux = dx / d, uy = dy / d
  const gap = arrow ? 9 : 2
  const x1 = a.x + ux * (a.r + 2), y1 = a.y + uy * (a.r + 2)
  const x2 = b.x - ux * (b.r + gap), y2 = b.y - uy * (b.r + gap)
  let s = '<line x1="' + num(x1) + '" y1="' + num(y1) + '" x2="' + num(x2) + '" y2="' + num(y2) +
    '" stroke="' + color + '" stroke-width="1.2" stroke-opacity="0.55" />'
  if (arrow) {
    const size = 8, half = 3.4
    const bx = x2 - ux * size, by = y2 - uy * size
    const px = -uy, py = ux
    s += '<polygon points="' + num(x2) + ',' + num(y2) + ' ' + num(bx + px * half) + ',' + num(by + py * half) + ' ' +
      num(bx - px * half) + ',' + num(by - py * half) + '" fill="' + color + '" fill-opacity="0.85" />'
  }
  return s
}
function nodeSvg(n: XY): string {
  const color = ENTITY_COLORS[n.type] || '#999'
  return '<circle cx="' + num(n.x) + '" cy="' + num(n.y) + '" r="' + n.r + '" fill="' + color + '" stroke="#fff" stroke-width="1.5" />' +
    '<text x="' + num(n.x) + '" y="' + num(n.y + 4) + '" font-size="11.5" font-weight="bold" fill="#1f2329" text-anchor="middle" paint-order="stroke" stroke="#ffffff" stroke-width="3">' +
    esc(cut(n.label, 12)) + '</text>'
}

/** 子图：按跳数同心分层（与界面一致的观感，静态版） */
function svgSubgraph(bundle: EvidenceBundle): string {
  const W = 1000, H = 620
  const cx = W / 2, cy = H / 2
  const nodes = bundle.graph.nodes
  if (nodes.length === 0) return ''
  const byHop: Record<number, typeof nodes> = {}
  nodes.forEach((n) => { const h = Math.min(3, n.hop || 0); (byHop[h] = byHop[h] || []).push(n) })
  const pos = new Map<string, XY>()
  const ringR = (h: number) => (h <= 0 ? 0 : h === 1 ? 150 : h === 2 ? 260 : 320)
  Object.keys(byHop).forEach((k) => {
    const h = Number(k), list = byHop[h]
    list.forEach((n, i) => {
      const rr = ringR(h)
      const ang = h === 0
        ? (list.length === 1 ? 0 : (i / list.length) * Math.PI * 2)
        : (i / list.length) * Math.PI * 2 + h * 0.3
      const rad = h === 0 ? (list.length === 1 ? 0 : 46) : rr
      pos.set(n.entityId, { x: cx + Math.cos(ang) * rad, y: cy + Math.sin(ang) * rad, r: h === 0 ? 15 : 10, label: n.name, type: n.type })
    })
  })
  let s = ''
  bundle.graph.links.forEach((l) => {
    const a = pos.get(l.from), b = pos.get(l.to)
    if (a && b) s += edgeSvg(a, b, RELATION_COLORS[l.relation] || '#999', true)
  })
  nodes.forEach((n) => { const p = pos.get(n.entityId); if (p) s += nodeSvg(p) })
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="max-width:1000px;height:auto;background:#fff;border:1px solid #e6e6e9;border-radius:6px">' + s + '</svg>'
}

/** 路径：图上通路（**无向**，一条一行）—— 14- A6 改名、去箭头 */
function svgChains(paths: GraphPath[]): string {
  if (!paths.length) return ''
  const rowH = 62, padL = 16, gap = 60
  let maxW = 0
  paths.forEach((p) => {
    let w = padL * 2
    p.nodes.forEach((n, i) => { w += Math.max(70, n.name.length * 13) + (i > 0 ? gap : 0) })
    if (w > maxW) maxW = w
  })
  const W = Math.max(520, maxW), H = paths.length * rowH + 12
  let s = ''
  paths.forEach((p, ri) => {
    const y = 34 + ri * rowH
    let x = padL
    p.nodes.forEach((n, i) => {
      const bw = Math.max(70, n.name.length * 13)
      if (i > 0) {
        const from = x - gap + 15, to = x - 15
        s += '<line x1="' + from + '" y1="' + y + '" x2="' + (to - 7) + '" y2="' + y + '" stroke="#98a2b3" stroke-width="1.3" />' +
          '<polygon points="' + to + ',' + y + ' ' + (to - 7) + ',' + (y - 4.5) + ' ' + (to - 7) + ',' + (y + 4.5) + '" fill="#98a2b3" />' +
          '<text x="' + ((from + to) / 2) + '" y="' + (y - 8) + '" font-size="10" fill="#9ca3af" text-anchor="middle">' +
          esc(p.edges[i - 1] ? p.edges[i - 1].relation : '') + '</text>'
      }
      const color = ENTITY_COLORS[n.type] || '#5b6270'
      s += '<rect x="' + x + '" y="' + (y - 15) + '" width="' + bw + '" height="30" rx="15" fill="' + color +
        '" fill-opacity="0.12" stroke="' + color + '" />' +
        '<text x="' + (x + bw / 2) + '" y="' + (y + 4.5) + '" font-size="12" fill="#313845" text-anchor="middle">' + esc(n.name) + '</text>'
      x += bw + gap
    })
  })
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="max-width:1000px;height:auto;background:#fff;border:1px solid #e6e6e9;border-radius:6px">' + s + '</svg>'
}

/**
 * 「先查哪个」树（**方案 D**）：根（问题锚点）/ 原因 / 措施，**从左往右**（静态 SVG）
 * 🔴 2026-10-11：原「诊断路径原样画」改为**直接调 `buildTree(bundle)`** —— 档案树 = 界面树，
 *    问题画像（正则判型）也统一在 `shared/build-tree.ts` 里判，档案不再各画一套（施工单《15-》§4.10）。
 */
function svgTree(b: EvidenceBundle): string {
  const root = buildTree(b)
  if (!root) return ''
  const rowH = 38, padT = 16, padL = 16, colW = 250
  let leaf = 0
  const flat: { node: TNode; depth: number; y: number }[] = []
  function layout(node: TNode, depth: number): number {
    if (!node.kids.length) { const y = leaf++; flat.push({ node, depth, y }); return y }
    const ys = node.kids.map((k) => layout(k, depth + 1))
    const y = ys.length ? (ys[0] + ys[ys.length - 1]) / 2 : leaf++
    flat.push({ node, depth, y })
    return y
  }
  layout(root, 0)
  const H = Math.max(leaf * rowH + padT * 2, 90)
  let maxD = 0
  flat.forEach((f) => { maxD = Math.max(maxD, f.depth) })
  const W = padL * 2 + (maxD + 1) * colW
  const at = new Map<TNode, { x: number; y: number }>()
  flat.forEach((f) => at.set(f.node, { x: padL + f.depth * colW, y: padT + f.y * rowH + rowH / 2 }))
  let s = ''
  flat.forEach((f) => {
    const me = at.get(f.node)
    if (!me) return
    const bw = Math.min(colW - 30, Math.max(70, f.node.name.length * 12 + 18))
    f.node.kids.forEach((k) => {
      const kp = at.get(k)
      if (!kp) return
      s += '<path d="M' + num(me.x + bw) + ' ' + num(me.y) + ' C' + num(me.x + bw + 46) + ' ' + num(me.y) + ', ' +
        num(kp.x - 46) + ' ' + num(kp.y) + ', ' + num(kp.x) + ' ' + num(kp.y) +
        '" fill="none" stroke="#d3d9e2" stroke-width="1.4" />'
      if (k.rel) s += '<text x="' + num((me.x + bw + kp.x) / 2) + '" y="' + num((me.y + kp.y) / 2 - 5) + '" font-size="10" fill="#9ca3af" text-anchor="middle">' + esc(k.rel) + '</text>'
    })
  })
  flat.forEach((f) => {
    const me = at.get(f.node)
    if (!me) return
    const color = f.node.type === '未配对' ? '#98a2b3' : (ENTITY_COLORS[f.node.type] || '#5b6270')
    const bw = Math.min(colW - 30, Math.max(70, f.node.name.length * 12 + 18))
    s += '<rect x="' + num(me.x) + '" y="' + num(me.y - 13) + '" width="' + num(bw) + '" height="26" rx="8" fill="' + color +
      '" fill-opacity="0.12" stroke="' + color + '" stroke-width="1.2" />' +
      '<text x="' + num(me.x + 9) + '" y="' + num(me.y + 4.5) + '" font-size="12" fill="#313845">' + esc(cut(f.node.name, 16)) + '</text>'
    if (f.node.score) s += '<text x="' + num(me.x + bw + 8) + '" y="' + num(me.y + 4.5) + '" font-size="11" fill="#9ca3af">' + esc(f.node.score) + '</text>'
  })
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="max-width:' + W + 'px;height:auto;background:#fff;border:1px solid #e6e6e9;border-radius:6px">' + s + '</svg>'
}

function legendHtml(): string {
  let s = '<div class="legend">'
  Object.keys(ENTITY_COLORS).forEach((k) => {
    s += '<span><i style="background:' + ENTITY_COLORS[k] + '"></i>' + esc(k) + '</span>'
  })
  Object.keys(RELATION_COLORS).forEach((k) => {
    s += '<span><i style="background:' + RELATION_COLORS[k] + '"></i>' + esc(k) + '</span>'
  })
  return s + '</div>'
}

// ---------------------------------------------------------------------------
// 环境与版本 / 本轮日志
// ---------------------------------------------------------------------------

function readJson(p: string): unknown {
  try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null } catch { return null }
}

function envBlock(paths: AppPaths): Record<string, unknown> {
  const pkg = readJson(join(paths.programRoot, 'package.json')) as { version?: string } | null
  const manifest = readJson(join(paths.dataDir, 'vector-index', 'manifest.json'))
  const cfgVersion = (sub: string): unknown => {
    const j = readJson(join(paths.configDir, sub, 'default.json')) as { version?: unknown; _version?: unknown } | null
    return j ? (j.version ?? j._version ?? '（无 version 字段）') : '（缺文件）'
  }
  return {
    appVersion: pkg && pkg.version ? pkg.version : '（读不到 package.json）',
    mode: paths.mode,
    programRoot: paths.programRoot,
    dataDir: paths.dataDir,
    configVersions: {
      retrieval: cfgVersion('retrieval'),
      evidence: cfgVersion('evidence'),
      models: cfgVersion('models'),
      prompts: cfgVersion('prompts'),
      logging: cfgVersion('logging'),
    },
    libraryManifest: manifest,
  }
}

/** 取本轮时间窗内的 app.log 事件（ISO 字符串可直接比较） */
function readLogSince(paths: AppPaths, sinceIso: string): string[] {
  const file = join(paths.logsDir, 'app.log')
  if (!existsSync(file)) return []
  try {
    const lines = readFileSync(file, 'utf8').trim().split('\n').slice(-500)
    return lines.filter((l) => {
      try { const o = JSON.parse(l) as { t?: string }; return typeof o.t === 'string' ? o.t >= sinceIso : true } catch { return false }
    })
  } catch { return [] }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export interface ArchiveResult { file: string | null; error: string | null }

export function writeTurnArchive(paths: AppPaths, cfg: LoggingConfig, input: TurnArchiveInput): ArchiveResult {
  try {
    const started = new Date(input.startedAt)
    const dir = join(paths.runtimeDir, cfg.archive.dir, dayKey(started))
    mkdirSync(dir, { recursive: true })
    const shortSess = input.sessionId.replace(/[^\w-]/g, '').slice(-8)
    const name = hhmmss(started) + '-' + shortSess + '-' + pad(input.turnIndex) + '.html'
    const file = join(dir, name)
    const appLog = readLogSince(paths, input.appLogSince)
    const raw = {
      bundleVersion: input.bundle ? input.bundle.bundleVersion : null,
      question: input.question,
      sessionId: input.sessionId,
      assistantMessageId: input.assistantMessageId,
      turnIndex: input.turnIndex,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      status: input.status,
      error: input.error,
      timeline: input.timeline,
      judgments: input.judgments,
      queryVector: input.queryVector,
      evidenceBundle: input.bundle,
      prompt: input.prompt,
      model: input.model,
      sse: input.sse,
      answer: input.answer,
    }
    const html = renderHtml(paths, input, cfg, { raw, appLog, env: envBlock(paths) })
    writeFileSync(file, html, 'utf8')
    // 跨轮统计（追加写；失败不影响主档案）
    try {
      appendFileSync(join(paths.runtimeDir, cfg.archive.dir, 'turns.jsonl'), JSON.stringify({
        t: new Date(input.finishedAt).toISOString(),
        sessionId: input.sessionId,
        assistantMessageId: input.assistantMessageId,
        turnIndex: input.turnIndex,
        question: input.question,
        status: input.status,
        ms: input.finishedAt - input.startedAt,
        evidenceLevel: input.bundle ? input.bundle.evidenceLevel : null,
        highestSimilarity: input.bundle ? input.bundle.highestSimilarity : null,
        paths: input.bundle ? input.bundle.status : null,
        file: name,
      }) + '\n', 'utf8')
    } catch { /* 统计行失败不影响档案 */ }
    return { file, error: null }
  } catch (err) {
    return { file: null, error: (err as Error).message }
  }
}

function renderHtml(
  paths: AppPaths,
  input: TurnArchiveInput,
  cfg: LoggingConfig,
  extra: { raw: unknown; appLog: string[]; env: Record<string, unknown> },
): string {
  const total = Math.max(1, input.finishedAt - input.startedAt)
  const b = input.bundle
  const block = (no: string, title: string, body: string, open: boolean) =>
    '<section class="blk' + (open ? ' open' : '') + '"><h2><span class="no">' + no + '</span>' + esc(title) + '</h2><div class="bd">' + body + '</div></section>'

  // ① 时间线
  let bars = ''
  input.timeline.forEach((t) => {
    const left = ((t.start - input.startedAt) / total) * 100
    const w = Math.max(0.4, (t.ms / total) * 100)
    bars += '<div class="bar-row"><span class="bar-name">' + esc(t.step) + '</span>' +
      '<span class="bar-track"><i style="left:' + left.toFixed(2) + '%;width:' + w.toFixed(2) + '%"></i></span>' +
      '<span class="bar-ms">' + t.ms + ' ms</span></div>'
    if (t.note) bars += '<div class="bar-note">' + esc(t.note) + '</div>'
  })

  // ⑤-⑨ 各块
  const kv = (o: Record<string, unknown>) =>
    '<table class="kv">' + Object.keys(o).map((k) => '<tr><th>' + esc(k) + '</th><td>' + esc(typeof o[k] === 'object' ? JSON.stringify(o[k]) : o[k]) + '</td></tr>').join('') + '</table>'

  // 🔴 v1.2：引用串**只用块编号**（来源定位字段已整体移除；不再依赖任何 ?? 兜底）
  const citeOfText = (e: { chunkId: string; kind: string; title?: string | null; sourceNote?: string | null }): string => {
    if (e.kind === 'user') {
      const t = e.title ? '『' + e.title + '』' : ''
      const n = e.sourceNote ? '（' + e.sourceNote + '）' : ''
      return '用户录入' + t + n + ' · 块 ' + e.chunkId
    }
    return '块 ' + e.chunkId
  }
  const textBlock = b ? (b.text.evidences.length
    ? b.text.evidences.map((e, i) => '<div class="cite"><div class="cl">[' + (i + 1) + '] ' + esc(citeOfText(e)) +
      ' · ' + (e.kind === 'user' ? '用户文本' : '父块') +
      ' · 路内分 ' + e.score.toFixed(4) + '</div><pre>' + esc(e.text) + '</pre></div>').join('')
    : '<p class="muted">（无原文证据）</p>') : '<p class="muted">（未检索）</p>'

  // 界面规则（§2.3.2.1）：画不出来就不显示 —— 档案仍保留原始数据，但要如实标注
  const sgHidden = b ? (b.graph.nodes.length <= 2 || b.graph.links.length === 0) : false
  const chHidden = b ? (b.graph.causalPaths.length === 0) : false
  const uiNote = (hidden: boolean, why: string): string =>
    hidden ? '<p class="note">⚠ 界面按「**画不出来就不显示**」规则**不会**显示这张图（' + esc(why) + '）；档案仍保留原始数据以便排查。</p>' : ''
  const graphBlock = b ? ('<p>种子 <b>' + b.graph.seeds.length + '</b> · 子图 <b>' + b.graph.nodes.length + ' 节点 / ' + b.graph.links.length +
    ' 边</b> · 图上通路 <b>' + b.graph.causalPaths.length + '</b> · 共现关联 <b>' + b.graph.cooccurrencePaths.length + '</b> · noPath=' + b.graph.noPath + '</p>' +
    uiNote(sgHidden, '节点 ≤2 或 边=0') + svgSubgraph(b) + '<h3>图上通路（无向）</h3>' +
    uiNote(chHidden, '图上通路 0 条') + (svgChains(b.graph.causalPaths) || '<p class="muted">（本次未找到图上通路）</p>') +
    '<h3>种子实体（含来源分）</h3><table class="grid"><tr><th>实体</th><th>类型</th><th>图路分</th><th>来源</th><th>证据块</th></tr>' +
    b.graph.seeds.map((s) => '<tr><td>' + esc(s.name) + '</td><td>' + esc(s.type) + '</td><td>' + s.score.toFixed(4) + '</td><td>' +
      esc(JSON.stringify(s.from)) + '</td><td>' + esc(s.evidenceChunkIds.join(', ')) + '</td></tr>').join('') + '</table>' +
    '<h3>共现关联（非因果）</h3>' + (b.graph.cooccurrencePaths.length
      ? b.graph.cooccurrencePaths.map((p) => '<p>' + esc(p.nodes.map((n) => n.name).join('  ↔  ')) + '</p>').join('')
      : '<p class="muted">（无）</p>')) : '<p class="muted">（未检索）</p>'

  const diagBlock = b ? (
    '<p class="muted">问题画像（正则判型）：<b>' + esc({ fault: '故障/原因', maint: '保养/维护', oper: '操作/测量' }[classifyQuestion(b.question)]) +
      '</b> —— 树与界面**同源**（shared/build-tree.ts · 方案 D，从左往右）</p>' +
    (svgTree(b) || '<p class="muted">（本轮不出树：证据不足 / 节点≤1 / 素材全空）</p>') +
    (b.diagnostics.paths.length
      ? '<h3>诊断路径原始表</h3><table class="grid"><tr><th>#</th><th>分</th><th>现象</th><th>原因</th><th>措施</th><th>配对</th></tr>' +
        b.diagnostics.paths.map((p) => '<tr><td>' + p.rank + '</td><td>' + p.score.toFixed(4) + '</td><td>' + esc(p.phenomenon ? p.phenomenon.name : '—') +
          '</td><td>' + esc(p.cause ? p.cause.name : '—') + '</td><td>' + esc(p.measures.map((m) => m.name).join('；')) +
          '</td><td>' + (p.pairMissing ? '<b>缺失</b>' : '已配对') + '</td></tr>').join('') + '</table>'
      : '<p class="muted">（无诊断路径）</p>')) : '<p class="muted">（未检索）</p>'
  const promptBlock = input.prompt
    ? ('<p>system ' + input.prompt.systemChars + ' 字 ｜ user（六段）' + input.prompt.userChars + ' 字' +
      (input.prompt.messageCount ? ' ｜ messages 共 ' + input.prompt.messageCount + ' 条（含历史）' : '') + '</p>' +
      '<h3>system</h3><pre>' + esc(input.prompt.system) + '</pre><h3>user（六段）</h3><pre>' + esc(input.prompt.user) + '</pre>')
    : '<p class="muted">（未组装提示词）</p>'

  const statusBlock = b ? kv(Object.keys(b.status).reduce<Record<string, unknown>>((acc, k) => {
    const st = b.status[k as keyof typeof b.status]
    acc[k] = st.state + ' · ' + st.ms + ' ms' + (st.error ? ' · ' + st.error : '')
    return acc
  }, {})) : '<p class="muted">（未检索）</p>'

  const judgBlock = input.judgments.length
    ? '<table class="grid"><tr><th>输入</th><th>判定规则</th><th>结论</th><th>降级</th></tr>' +
      input.judgments.map((j) => '<tr><td>' + esc(j.input) + '</td><td>' + esc(j.rule) + '</td><td>' + esc(j.result) + '</td><td>' +
        (j.degraded ? '<b style="color:#b54708">是</b>' : '—') + '</td></tr>').join('') + '</table>'
    : '<p class="muted">（无）</p>'

  const logLines = extra.appLog.length
    ? '<pre>' + esc(extra.appLog.join('\n')) + '</pre>'
    : '<p class="muted">（本轮时间窗内无 app.log 事件）</p>'

  const sseBlock = input.sse.length
    ? '<details><summary>原始 SSE 共 ' + input.sse.length + ' 行（约 ' + Math.round(JSON.stringify(input.sse).length / 1024) + ' KB）</summary><pre>' + esc(input.sse.join('\n')) + '</pre></details>'
    : '<p class="muted">（无 SSE 记录：可能是拒答短路，或未调用模型）</p>'

  const blocks = [
    block('①', '封面与时间线', '<p class="q">' + esc(input.question) + '</p>' + bars, true),
    block('②', '环境与版本', kv({
      程序版本: (extra.env as { appVersion?: string }).appVersion,
      布局: (extra.env as { mode?: string }).mode,
      配置版本: JSON.stringify((extra.env as { configVersions?: unknown }).configVersions),
      程序根: paths.programRoot,
      数据根: paths.dataDir,
      档案开关: JSON.stringify(cfg.archive),
    }) + '<details><summary>两库装箱单 manifest.json</summary><pre>' + esc(JSON.stringify((extra.env as { libraryManifest?: unknown }).libraryManifest, null, 1)) + '</pre></details>', false),
    block('③', '本轮身份', kv({
      会话: input.sessionId, 助手消息: input.assistantMessageId, 用户消息: input.userMessageId,
      轮次: input.turnIndex, 首轮: input.isFirst, 已停止: input.stopped, 状态: input.status,
      开始: new Date(input.startedAt).toISOString(), 结束: new Date(input.finishedAt).toISOString(), 总耗时: (input.finishedAt - input.startedAt) + ' ms',
      错误: input.error ?? '（无）',
    }), false),
    block('④', '问题预处理与查询向量', '<p class="muted">查询向量：' + (input.queryVector ? input.queryVector.length + ' 维（L2 归一化；只存本体，不存库向量）' : '（未编码）') + '</p>' +
      (input.queryVector ? '<details><summary>查询向量（前 16 维预览）</summary><pre>' + esc(JSON.stringify(input.queryVector.slice(0, 16))) + '</pre></details>' : ''), false),
    block('⑤', '文本路（原文证据）', textBlock, false),
    block('⑥', '图路（子图与路径）', graphBlock, false),
    block('⑦', '诊断路径 · 先查哪个', diagBlock, false),
    block('⑧', '逐路状态', statusBlock, false),
    block('⑨', '提示词（六段原文）', promptBlock, false),
    block('⑩', '模型调用', kv({ 端口: input.model.port, 参数: JSON.stringify(input.model.params), SSE行数: input.sse.length }) + sseBlock, false),
    block('⑪', '回答', '<pre>' + esc(input.answer) + '</pre>', false),
    block('⑫', '异常与降级', '<p>' + esc(input.error ?? '（本轮无异常）') + '</p>' + (b && b.notes.length ? '<ul>' + b.notes.map((n) => '<li>' + esc(n) + '</li>').join('') + '</ul>' : ''), false),
    block('⑬', '本轮内部日志（app.log 事件行）', logLines, false),
    block('⑭', '判断清单（输入 → 规则 → 结论）', judgBlock, false),
    block('⑮', '原始数据（内联 JSON）', '<p class="muted">见文末 &lt;script type="application/json"&gt; 块；含证据包 / 提示词 / SSE / 时间线 / 判断清单的完整副本。</p>', false),
  ].join('')

  const style = [
    '*{box-sizing:border-box}', 'body{margin:0;background:#f7f7f8;color:#1f2329;font:14px/1.7 "Segoe UI","Microsoft YaHei",sans-serif}',
    '.wrap{max-width:1080px;margin:0 auto;padding:18px 16px 60px}', 'h1{font-size:20px;margin:0 0 4px}',
    '.sub{color:#6b7280;font-size:12.5px;margin-bottom:14px}',
    '.blk{background:#fff;border:1px solid #e6e6e9;border-radius:10px;margin-bottom:10px;overflow:hidden}',
    '.blk h2{font-size:14px;margin:0;padding:10px 14px;cursor:default;background:#fcfcfd;border-bottom:1px solid #e6e6e9}',
    '.blk .no{display:inline-block;width:22px;color:#2f6bff}', '.blk .bd{padding:12px 14px}',
    '.q{font-size:15px;font-weight:600;margin:0 0 10px}', '.muted{color:#9ca3af}',
    '.bar-row{display:flex;align-items:center;gap:8px;margin-bottom:5px;font-size:12.5px}',
    '.bar-name{width:130px;color:#4b5563}.bar-ms{width:72px;text-align:right;color:#9ca3af}',
    '.bar-track{position:relative;flex:1;height:12px;background:#f0f1f3;border-radius:6px;overflow:hidden}',
    '.bar-track i{position:absolute;top:0;bottom:0;background:#2f6bff;border-radius:6px;min-width:2px}',
    '.bar-note{color:#b54708;font-size:12px;margin:0 0 8px 138px}',
    'pre{white-space:pre-wrap;word-break:break-word;background:#fbfbfd;border:1px solid #eceef1;border-radius:8px;padding:10px;font-size:12.5px;max-height:420px;overflow:auto}',
    'table{border-collapse:collapse;width:100%;font-size:12.5px;margin:8px 0}',
    'table.kv th{text-align:left;width:150px;color:#6b7280;font-weight:400;padding:4px 8px;border-bottom:1px solid #f0f1f3}',
    'table.kv td{padding:4px 8px;border-bottom:1px solid #f0f1f3}',
    'table.grid th,table.grid td{border:1px solid #eceef1;padding:5px 8px;text-align:left}',
    'table.grid th{background:#fcfcfd;color:#6b7280;font-weight:600}',
    '.cite{border:1px solid #eceef1;border-radius:8px;padding:8px 10px;margin-bottom:8px}',
    '.cl{font-size:12.5px;color:#4b5563;margin-bottom:6px}',
    '.legend{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:6px;font-size:12px;color:#6b7280}',
    '.legend span{display:flex;align-items:center;gap:5px}', '.legend i{width:14px;height:14px;border-radius:50%;display:inline-block}',
    'h3{font-size:13px;margin:14px 0 6px;color:#4b5563}', 'details summary{cursor:pointer;color:#2f6bff;font-size:12.5px}',
    '.foot{margin-top:18px;color:#9ca3af;font-size:12px}',
    '.note{background:#fff8e6;border:1px solid #f3e0b5;border-radius:8px;padding:8px 10px;font-size:12.5px;color:#b54708}',
  ].join('')
  const json = JSON.stringify(extra.raw)

  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>问答档案 · ' + esc(cut(input.question, 40)) + '</title><style>' + style + '</style></head><body><div class="wrap">' +
    '<h1>问答档案（一轮一份 · 全部操作）</h1>' +
    '<div class="sub">' + esc(new Date(input.startedAt).toLocaleString()) + ' ｜ 会话 ' + esc(input.sessionId) + ' ｜ 第 ' + input.turnIndex +
    ' 轮 ｜ 状态 ' + esc(input.status) + ' ｜ 总耗时 ' + (input.finishedAt - input.startedAt) + ' ms ｜ 档案目录 ' + esc(cfg.archive.dir) + '</div>' +
    blocks + legendHtml() +
    '<div class="foot">本文件由 qa-core 生成（决策 D26 /《技术总纲》§7.6.1）。原始 JSON 内联在下方，可被脚本直接解析。</div>' +
    '</div><script type="application/json" id="raw-turn">' + json.replace(/</g, '\\u003c') + '</script></body></html>'
}
