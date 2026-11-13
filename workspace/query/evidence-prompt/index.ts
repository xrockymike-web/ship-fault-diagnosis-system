/**
 * 证据组装与提示词拼接（目标 2 只用到「提示词拼接」这一半）。
 *
 * **D2-13**：提示词与历史裁剪从渲染进程搬到这里 —— 后端既然自己发 HTTP 请求，
 * payload 就必须由后端构造。目标 4 引入 EvidenceBundle 时**只增不改**。
 *
 * 本模块**不 import** launcher/bootstrap 的运行时成员（只 `import type`）：
 * 它会被 utilityProcess 里的 qa-core 加载，而那里没有完整的 Electron API。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppPaths } from '../launcher/bootstrap/index'
import type { CitationRef, EvidenceBundle, TextEvidence } from '../shared/types'

export interface PromptsConfig {
  system: string
  grounded: string
  noEvidence: string
  answerFormat: string
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/** 发给 llama-server 的消息（第一条是 system） */
export interface WireMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface HistoryOptions {
  /** 最近 N 轮（一轮 = 一问一答） */
  historyTurns: number
  /** 历史总字符上限 */
  historyCharLimit: number
}

/** 读 `config/prompts/default.json`；缺失或损坏**必须明确报错**，不静默降级（红线） */
export function loadPrompts(paths: AppPaths): PromptsConfig {
  const file = join(paths.configDir, 'prompts', 'default.json')
  if (!existsSync(file)) throw new Error('缺少提示词配置：' + file)
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as PromptsConfig
  } catch (err) {
    throw new Error('提示词配置无法解析：' + file + '\n' + (err as Error).message)
  }
}

/**
 * 目标 1 口径的系统提示 = `system` + `answerFormat`。
 *
 * ⚠️ **不用 `grounded`**：目标 2 仍没有检索、没有 EvidenceBundle，套用「只依据给定的资料回答」
 * 会让模型对**每个**问题都回「资料不足」（阶段 1 实测，见《阶段1开发过程》问题 16）。
 * `grounded` 与证据包一起在目标 4/5 引入。
 */
export function buildSystemPrompt(cfg: PromptsConfig): string {
  return cfg.system + '\n' + cfg.answerFormat
}

/**
 * 按「最近 N 轮 + 字符上限」裁剪历史 —— **从 `useLlamaStream.ts` 原样搬来，口径不变**。
 * 历史里**不含**本轮提问；`history` 的最后一条就是本轮提问。
 */
export function buildMessages(
  history: ChatMessage[],
  opts: HistoryOptions,
  systemPrompt: string,
): WireMessage[] {
  const current = history[history.length - 1]
  const past = history.slice(0, -1)

  // 一轮 = 一问一答；只保留最近 historyTurns 轮
  const keepFrom = Math.max(0, past.length - opts.historyTurns * 2)
  let kept = past.slice(keepFrom)

  // 再按字符上限从**最旧**开始丢（保留离当前问题最近的上下文）
  let chars = kept.reduce((n, m) => n + m.content.length, 0) + (current?.content.length ?? 0)
  while (kept.length > 0 && chars > opts.historyCharLimit) {
    chars -= kept[0].content.length
    kept = kept.slice(1)
  }

  const out: WireMessage[] = [{ role: 'system', content: systemPrompt }]
  for (const m of kept) out.push({ role: m.role, content: m.content })
  if (current) out.push({ role: current.role, content: current.content })
  return out
}

// ---------------------------------------------------------------------------
// 目标 4 · 4.5：**只增不改** —— 上面三个函数（目标 2 的纯对话口径）一字未动
// 新增：证据配置加载 / 引用编号 / 七段提示词（证据绑定口径）
// ---------------------------------------------------------------------------

/** `config/evidence/default.json`（A8 三档阈值 + 七段预算 + 子图开关） */
export interface EvidenceConfig {
  sufficiency: { sufficient: number; partial: number }
  prompt: {
    budgetTokens: {
      /** 🔴 死键：代码从不读（system 段是写死的字符串，见 evidence/default.json 的 _roleRules_dead_note） */
      roleRules: number
      textEvidence: number
      entities: number
      /** 🆕 14-：⑤ 图上通路段（400 token）—— 路径进提示词 */
      paths?: number
      diagnostics: number
      answer: number
    }
    /** 🆕 14- A11：总量保险丝（7800）—— 超了先裁历史、再不够才裁证据末条并显式标注 */
    maxTotalTokens?: number
    includeSubgraphInPrompt: boolean
    includePathScores: boolean
    evidenceCharLimitPerItem: number
    /** 规则口径：full = 软件现状（5 条含引用/路径语义/诊断排序）；minimal = 实验口径（只留“依据资料 + 长度”） */
    rulesStyle?: 'full' | 'minimal'
    /** 是否把【诊断路径】段放进提示词；默认 true（软件），实验可设 false */
    includeDiagnostics?: boolean
  }
  reranker: { enabled: boolean }
}

/** 读 `config/evidence/default.json`；缺失或损坏**必须明确报错**（红线：不静默降级） */
export function loadEvidenceConfig(paths: AppPaths): EvidenceConfig {
  const file = join(paths.configDir, 'evidence', 'default.json')
  if (!existsSync(file)) throw new Error('缺少证据配置：' + file)
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as EvidenceConfig
  } catch (err) {
    throw new Error('证据配置无法解析：' + file + '\n' + (err as Error).message)
  }
}

/** token 预算 → 字符预算（沿用文档口径：token ≈ 字数 / 1.6） */
const charBudget = (tokens: number): number => Math.floor(tokens * 1.6)

/**
 * **包内排好 [编号]**（A9 第 3 条）—— 模型看到的 [3] 与界面显示的 [3] 必须是同一个。
 * 只给**提示词里真的展示了内容**的东西编号：③ 原文块 + ④ 子图节点。
 * 路径 / 诊断边上挂的 `chunk_id` 以「证据:<id>」原样打印（**不占编号**），
 * 避免出现「有编号、无正文」的悬空引用。
 */
export function assignCitations(bundle: EvidenceBundle): EvidenceBundle {
  const citations: CitationRef[] = []
  let no = 0
  for (const e of bundle.text.evidences) citations.push({ no: ++no, kind: 'chunk', refId: e.chunkId })
  for (const n of bundle.graph.nodes) citations.push({ no: ++no, kind: 'entity', refId: n.entityId })
  bundle.citations = citations
  return bundle
}

function refOf(bundle: EvidenceBundle, kind: CitationRef['kind'], refId: string): string {
  const hit = bundle.citations.find((c) => c.kind === kind && c.refId === refId)
  return hit ? '[' + hit.no + ']' : ''
}

/**
 * ③ 段每条证据的"来源头"（v1.2 证据定位单轨化）。
 *
 * 🔴 **只用块编号**：`· [2] 块 PRT-0012`
 *   · 不再拼文档名 / 章节 / 页码 / 表图号（这些字段已从契约与数据中删除）；
 *   · 块号一律写成 `块 <id>`，**不写成 `[<id>]`** —— 避免与 `[n]` 引用编号混淆（0.6B 尤其敏感）；
 *   · **权威性信号保留**：用户自建文本仍必须显式低于语料（D29 唯一提示词落点），
 *     判据由"有没有章节页码"改为 `kind === 'user'`（不再依赖任何来源字段）。
 */
function citeOf(bundle: EvidenceBundle, e: TextEvidence): string {
  const base = refOf(bundle, 'chunk', e.chunkId)
  if (e.kind === 'user') {
    const title = e.title ? '『' + e.title + '』' : ''
    const note = e.sourceNote ? '（' + e.sourceNote + '）' : ''
    return base + ' 用户录入' + title + note + ' · 块 ' + e.chunkId + '（权威性低于语料库）'
  }
  return base + ' 块 ' + e.chunkId
}

/** ③ 【原文证据】—— finalK 条父段落，带块编号与命中子块
 *  🔴 14- C4：原「三条合计 3000 字」老闸门**已取消**（实测约一成会截，截的是证据本体）。
 *     现由段预算（textEvidence=2200 token = 3520 字，盖住实测最长 3495 字）兜底；
 *     `limitOverride` 只在 `maxTotalTokens` 总量保险丝触发时由 buildGroundedMessages 传入 —— **显式截断、不静默**。
 */
export function formatTextSection(bundle: EvidenceBundle, cfg: EvidenceConfig, limitOverride?: number): string {
  const rows = bundle.text.evidences
  if (rows.length === 0) return '【原文证据】（无）'
  const limit = Math.min(charBudget(cfg.prompt.budgetTokens.textEvidence), limitOverride ?? Number.MAX_SAFE_INTEGER)
  const per = cfg.prompt.evidenceCharLimitPerItem
  const out: string[] = ['【原文证据】']
  let used = 0
  for (const e of rows) {
    // 🔴 v1.2：来源头只带块编号（2026-10-22 起不再有表格语义标记）
    const head = '· ' + citeOf(bundle, e)
    let body = e.text.length > per ? e.text.slice(0, per) + '…（已截）' : e.text
    const block = head + '\n' + body
    if (used + block.length > limit) {
      const room = Math.max(0, limit - used - head.length - 1)
      if (room < 40) {
        out.push(head + '\n…（超出总预算，本条已裁 —— 见 maxTotalTokens 保险丝）')
        break
      }
      body = body.slice(0, room) + '…（已达预算）'
      out.push(head + '\n' + body)
      break
    }
    out.push(block)
    used += block.length
  }
  // 🔴 v1.2：块编号成为唯一引用单位后，必须**去掉已在本段出现的父块号**，
  //    否则同一块号在一行内重复出现（段头 + 命中子块），抬显著度、混淆 0.6B。
  const headIds = new Set(rows.map((e) => e.chunkId))
  const hits = rows
    .map((e) => e.matches.map((m) => m.chunkId).filter((id) => !headIds.has(id)).join(','))
    .filter(Boolean)
    .join(' | ')
  if (hits) out.push('（命中子块：' + hits + '）')
  return out.join('\n')
}

/** ④ 【知识图谱·局部子图】—— **分组短句**（不写 JSON、不带 chunk_id）；**只走关系图**
 *  🆕 14- A9：**补孤立节点清单** —— 实测 Q1「节点 8 / 边 0」时段里 **0 个名字**，
 *     模型完全不知道找到了什么；现在无论有没有边，节点名都必须露面（超 15 个截断并计数）。
 */
export function formatGraphSection(bundle: EvidenceBundle, cfg: EvidenceConfig): string {
  const g = bundle.graph
  if (!cfg.prompt.includeSubgraphInPrompt) {
    if (g.seeds.length === 0) return '【知识图谱·相关实体】（无）'
    return '【知识图谱·相关实体】' + g.seeds.map((s) => s.name + '（' + s.type + '）').join('；')
  }
  const budget = charBudget(cfg.prompt.budgetTokens.entities)
  const head = '【知识图谱·局部子图】节点 ' + g.nodes.length + ' / 边 ' + g.links.length
  const isoLine = (names: string[]): string => {
    if (names.length === 0) return ''
    const shown = names.slice(0, 15)
    return '孤立节点：' + shown.join('、') + (names.length > 15 ? '…等 ' + names.length + ' 个' : '')
  }
  const linked = new Set<string>()
  for (const l of g.links) { linked.add(l.from); linked.add(l.to) }
  const isoNames = g.nodes.filter((n) => !linked.has(n.entityId)).map((n) => n.name)

  if (g.links.length === 0) {
    const iso = isoLine(g.nodes.map((n) => n.name))
    return head + '\n（本次没有取到关系边）' + (iso ? '\n' + iso : '')
  }
  const byRel = new Map<string, string[]>()
  for (const l of g.links) {
    if (!byRel.has(l.relation)) byRel.set(l.relation, [])
    byRel.get(l.relation)!.push(l.fromName + '→' + l.toName)
  }
  const order = ['导致', '对应']
  const rels = [...byRel.keys()].sort((x, y) => {
    const ix = order.indexOf(x), iy = order.indexOf(y)
    return (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy) || x.localeCompare(y)
  })
  const lines = [head]
  let used = head.length
  for (const r of rels) {
    const line = r + '：' + byRel.get(r)!.join('；')
    if (used + line.length > budget) {
      lines.push('…（子图已达预算 ' + budget + ' 字，其余 ' + rels.length + ' 类关系未展示）')
      used = budget
      break
    }
    lines.push(line)
    used += line.length
  }
  const iso = isoLine(isoNames)
  if (iso) lines.push(iso) // 预算再紧也保留孤立节点行（节点是子图「全部进」的一半）
  return lines.join('\n')
}

/** ⑤ 【知识图谱·图上通路】—— 🆕 14-：路径进提示词（13- §6.4 第 2 步；裁决见 14- §3.4.2：散边保留、通路**新增独立段**）
 *  · **无向**：只表示图上连通，不表示因果方向（依据：全图方向正确的「导致→导致」长链 = 0 条）；
 *  · 用「—关系—」连接而非箭头，与前端去箭头一致；关系名照标，非 导致/对应 即非因果。
 */
export function formatPathSection(bundle: EvidenceBundle, cfg: EvidenceConfig): string {
  const paths = bundle.graph.causalPaths
  if (paths.length === 0) return ''
  const budget = charBudget(cfg.prompt.budgetTokens.paths ?? 200)
  const out: string[] = ['【知识图谱·图上通路】（**无向**，只表示图上连通、不表示因果方向；关系名照标，非「导致/对应」即非因果）']
  let used = out[0].length
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i]
    const names = p.nodes.map((n) => n.name)
    const rels = p.edges.map((e) => e.relation)
    let line = String(i + 1) + '. '
    names.forEach((n, k) => { line += (k > 0 ? ' —' + (rels[k - 1] || '关联') + '— ' : '') + n })
    const evs: string[] = []
    for (const e of p.edges) for (const c of e.evidenceChunkIds) if (!evs.includes(c)) evs.push(c)
    if (evs.length > 0) line += '（证据：' + evs.slice(0, 3).join('，') + '）'
    if (used + line.length > budget) {
      out.push('…（通路段已达预算 ' + budget + ' 字，其余 ' + (paths.length - i) + ' 条未展示）')
      break
    }
    out.push(line)
    used += line.length
  }
  return out.join('\n')
}

/** ⑤ 【知识图谱·诊断路径】—— 排序链 + 分数 + 证据；配对缺失**并列展示** */
export function formatDiagnosticsSection(bundle: EvidenceBundle, cfg: EvidenceConfig): string {
  const rows = bundle.diagnostics.paths
  if (rows.length === 0) return ''
  const budget = charBudget(cfg.prompt.budgetTokens.diagnostics)
  const out: string[] = ['【知识图谱·诊断路径】（按分数排序；「证据:」为该边挂的原文块）']
  let used = out[0].length
  for (const p of rows) {
    const chain: string[] = []
    if (p.cause) chain.push(p.cause.name)
    if (p.phenomenon) chain.push(p.phenomenon.name)
    const head =
      p.rank + '. ' + chain.join(' →') +
      (p.measures.length > 0 ? ' → ' + p.measures.map((m) => m.name).join(' / ') : '') +
      (cfg.prompt.includePathScores ? '（分 ' + p.score.toFixed(3) + '）' : '') +
      (p.pairMissing ? '【配对缺失：原因与措施并列，不强配】' : '')
    const ev = p.edges.map((e) => e.relation + ':' + (e.evidenceChunkIds[0] ?? '无证据')).join('，')
    const line = head + '\n   证据：' + ev
    if (used + line.length > budget) break
    out.push(line)
    used += line.length
  }
  return out.join('\n')
}

const MINIMAL_RULES = [
  '【规则】',
  '1. 只依据下面的资料回答；资料不足就说明资料不足，不要编造。',
].join('\n')

const MINIMAL_TAIL = '\n\n【作答要求】总长 300–450 字。'

const GROUNDED_RULES = [
  '【角色与规则】',
  '1. 只依据下面的资料回答，不得编造；资料不足就明确说「无法判断」，并说明缺什么。',
  '2. 每条结论后面用方括号编号标出证据出处，写法如 [1]；只写这个编号，编号后面不要再加任何说明。',
  '3. 【图上通路】与【共现关联】只表示「图上连得起来 / 常出现在同一段原文」，**没有因果含义、也不表示方向**，不得当作原因。',
  '4. 诊断路径按分数从高到低给出排查顺序；**分数相同时按证据块数多者先**；标了「配对缺失」的，把原因与措施并列说明，不要硬配对。',
  // 🔴 v1.2：块编号成为资料里**唯一可见的标识符** → 必须明确列入禁抄清单。
  //    否则 0.6B 必然照抄裸块号（如「块 TXT-0001」），而前端只净化文献名/页码/「（证据：…）」，
  //    裸块号会直接留在回答正文里。
  '6. 🔴 引用只写 [1] 这种形式（只写阿拉伯数字，不要写 [n] / [n:1] / 【】；同一编号可重复引用）；**不确定编号时宁可不写来源，也不要输出空 []**；**不要抄文献名、章节名、页码、块编号（如「块 TXT-0001」）、chunk id**。',
].join('\n')

/** 题末「作答要求」（2026-10-11 16-：风格与引用纪律；放在问题之后 = 就近生效，0.6B 实测有效）
 *  🆕 2026-10-19（实验口径统一）：加「逐点覆盖要点，总长 300–450 字」——四臂同一条长度要求，
 *     否则"答案长短"会和"检索架构"混在一起（实测字数 240 vs 427 vs 536，判分奖励覆盖 → 长答案占优）。 */
const ANSWER_TAIL = [
  '',
  '【作答要求】有依据时先用一句话给结论，再按逻辑顺序讲清原因、检查或处置步骤与注意事项；',
  '把资料合成自己的话讲，不要逐条抄；每条结论后面标 [n]；资料里没有的不写。',
  '逐点覆盖资料里的要点，总长控制在 300–450 字。',
].join('\n')

/**
 * 证据绑定的消息组装（**六段**；2026-10-19 起 七段 → 六段，②「本题所属领域」整段删除）：
 *   system = ① 角色与规则
 *   最后一条 user = ② 原文证据 + ③ 局部子图 + ④ **图上通路（14-，路径进提示词）** + ⑤ 诊断路径 + ⑥ 用户问题
 * 段编号统一按《技术总纲》§4.3.4 G 口径（14- A7）；历史裁剪口径与 buildMessages 完全一致。
 *
 * 🔴 **总量保险丝**（负责人 2026-10-11 拍板「④ 预算上调 + 总量保险丝」）：
 *   system + 历史 + 六段 + 问题 ≤ (maxTotalTokens − answer) × 1.6 字；
 *   超了**先从最旧历史裁**；仍超 → 收紧② 原文证据段并**显式标注**（证据永不静默截断）。
 */
export function buildGroundedMessages(
  bundle: EvidenceBundle,
  history: ChatMessage[],
  opts: HistoryOptions,
  prompts: PromptsConfig,
  cfg: EvidenceConfig,
): WireMessage[] {
  const current = history[history.length - 1]
  const past = history.slice(0, -1)
  const keepFrom = Math.max(0, past.length - opts.historyTurns * 2)
  let kept = past.slice(keepFrom)
  let chars = kept.reduce((n, m) => n + m.content.length, 0) + (current?.content.length ?? 0)
  while (kept.length > 0 && chars > opts.historyCharLimit) {
    chars -= kept[0].content.length
    kept = kept.slice(1)
  }

  const minimal = cfg.prompt.rulesStyle === 'minimal'
  const system = [prompts.grounded, minimal ? MINIMAL_RULES : GROUNDED_RULES].join('\n\n')
  const tail = '\n\n【用户问题】\n' + (current?.content ?? '') + (minimal ? MINIMAL_TAIL : ANSWER_TAIL)
  const evidenceParts = (textLimit?: number): string =>
    [formatTextSection(bundle, cfg, textLimit), formatGraphSection(bundle, cfg), formatPathSection(bundle, cfg), cfg.prompt.includeDiagnostics === false ? '' : formatDiagnosticsSection(bundle, cfg)]
      .filter((s) => s.length > 0)
      .join('\n\n')
  const keptChars = (): number => kept.reduce((n, m) => n + m.content.length, 0)

  const answerTok = cfg.prompt.budgetTokens.answer ?? 800
  const maxTotal = cfg.prompt.maxTotalTokens ?? 7800
  const budgetChars = Math.max(4000, Math.floor((maxTotal - answerTok) * 1.6))
  let evidence = evidenceParts()
  let total = system.length + keptChars() + evidence.length + tail.length
  while (kept.length > 0 && total > budgetChars) {
    total -= kept[0].content.length
    kept = kept.slice(1)
  }
  if (total > budgetChars) {
    const others = system.length + keptChars() + tail.length + 64
    evidence = evidenceParts(Math.max(400, budgetChars - others))
  }

  const out: WireMessage[] = [{ role: 'system', content: system }]
  for (const m of kept) out.push({ role: m.role, content: m.content })
  out.push({ role: 'user', content: evidence + tail })
  return out
}
