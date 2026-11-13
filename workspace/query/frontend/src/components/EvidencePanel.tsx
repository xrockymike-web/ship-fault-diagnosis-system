/**
 * 目标 5 · 「证据与诊断」面板 + 三份图（决策 F24–F29 / §2.3.2.1）
 *
 * 版式：**文字在回答之前**（默认收起、只含文字）→ 回答 → **三份图在回答之后依次排开、默认展开**。
 * 两条硬规则：
 *   · **画不出来就不显示**（F27）：内容太少的图**整块不出现，连框都不留**；
 *   · **降级不静默**（C2）：某路失败/超时时，面板里出一行提示。
 */
import { useMemo, useState } from 'react'
import type { EvidenceBundle } from '../../../shared/types'
import { buildTree, ChainFigure, SubgraphFigure, treeDepth, treeNodeCount, TreeFigure } from './TurnFigures'
import { tr } from '../lang/provider'

/** 从问题里粗略抽关键词（用于引用片段的**粗定位**高亮 —— 目标 5 风险表已登记"精度后续提升"） */
function termsOf(question: string): string[] {
  const raw = question.replace(/[？?。，,、；;：:！!（）()《》\s]/g, ' ')
  const out = new Set<string>()
  raw.split(' ').forEach((w) => {
    if (w.length >= 2 && w.length <= 6) out.add(w)
    if (w.length > 6) { out.add(w.slice(0, 3)); out.add(w.slice(-3)) }
  })
  return [...out].filter((t) => t.length >= 2).slice(0, 8)
}

function Highlight({ text, terms }: { text: string; terms: string[] }) {
  const parts = useMemo(() => {
    if (!terms.length) return [text]
    const re = new RegExp('(' + terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'g')
    return text.split(re)
  }, [text, terms])
  return (
    <div className="cite-frag">
      {parts.map((p, i) => (terms.indexOf(p) >= 0 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>))}
    </div>
  )
}

/** qa-core 的 EvidenceLevel 是英文枚举 —— 界面显示中文（三档：充足 / 部分 / 不足） */
const LEVEL_ZH: Record<string, string> = { sufficient: '充足', partial: '部分', insufficient: '不足' }
function levelZh(lv: string): string { return LEVEL_ZH[lv] ?? lv }
function levelLabel(lv: string): string { const zh = LEVEL_ZH[lv] ?? lv; return tr(zh as never) }

export default function EvidencePanel({ bundle, question, msgId, answer }: { bundle?: EvidenceBundle | null; question: string; msgId: string; answer?: string }) {
  const [open, setOpen] = useState(false)
  const [fullCite, setFullCite] = useState<number | null>(null)
  if (!bundle) {
    // 老会话 / 纯对话口径：如实说明，不伪造证据（D28）
    return (
      <div className="evidence">
        <div className="ev-head" style={{ cursor: 'default' }}>
          <span className="ev-caret">▸</span>
          <span className="ev-title">{tr("证据与诊断")}</span>
          <span className="ev-count">{tr("本轮未留存证据（该回答产生于「证据落库」功能之前，或为纯对话口径）")}</span>
        </div>
      </div>
    )
  }
  const terms = termsOf(question)
  const failed = (Object.keys(bundle.status) as (keyof typeof bundle.status)[])
    .filter((k) => bundle.status[k].state !== 'ok')
    .map((k) => k + '：' + bundle.status[k].state + (bundle.status[k].error ? '（' + bundle.status[k].error + '）' : ''))
  const cooc = bundle.graph.cooccurrencePaths.map((p) => p.nodes.map((n) => n.name).join(' ↔ '))
  const weight = tr('共 {e} 条引用 · {n} 节点 · {p} 条路径', { e: bundle.text.evidences.length, n: bundle.graph.nodes.length, p: bundle.diagnostics.paths.length })
  // 🔴 2026-10-11（施工单《16-》§8）：标出「本回答**实际引用**了哪几条证据」——
  //    模型标没标、标得全不全，用户一眼看清；**模型一个字不标时，这里也把"可依据的材料"摆出来**（确定性，不依赖模型）。
  const evCount = bundle.text.evidences.length
  // 🔴 编号空间 = 证据包 citations 总数（实测可达 43：含原文证据 + 图谱节点 + 通路），面板卡片只列前 evCount 条原文证据。
  const citeSpace = Array.isArray(bundle.citations) ? bundle.citations.length : evCount
  const used = new Set<number>()
  if (answer) {
    for (const m of answer.matchAll(/\[(?:n\s*[:：]\s*)?(\d{1,3})\]/g)) {
      const n = Number(m[1])
      if (n >= 1 && n <= citeSpace) used.add(n)
    }
  }
  const usedCard = [...used].filter((n) => n <= evCount)   // 落在「原文证据卡片」范围内的
  const usedBeyond = used.size - usedCard.length           // 指向图谱/通路证据的编号数

  return (
    <div className="evidence">
      <div className="ev-head" onClick={() => setOpen((v) => !v)}>
        <span className="ev-caret">{open ? '▾' : '▸'}</span>
        <span className="ev-title">{tr("证据与诊断")}</span>
        <span className={'ev-badge ' + levelZh(bundle.evidenceLevel)}>{levelLabel(bundle.evidenceLevel)}</span>
        <span className="ev-count">{weight}</span>
      </div>
      {open ? (
        <div className="ev-body">
          <div className="ev-sec">
            <h4>
              {tr('引用来源（{n}）', { n: evCount })}{' '}
              {answer ? (
                used.size > 0 ? (
                  <span className="ev-note" style={{ fontWeight: 400 }}>
                    {' '}{tr('—— 本回答引用了')} {[...used].sort((a, b) => a - b).map((x) => '[' + x + ']').join('')}
                    {tr('（原文证据 {a}/{b} 条被引用', { a: usedCard.length, b: evCount })}
                    {usedBeyond > 0 ? tr('，另 {n} 个编号指向图谱/通路证据）', { n: usedBeyond }) : '）'}
                  </span>
                ) : (
                  <span className="ev-note" style={{ fontWeight: 400 }}>{tr("—— 本回答未标注编号，以下为本轮可依据的证据")}</span>
                )
              ) : null}
            </h4>
            {bundle.text.evidences.length === 0 ? <p className="ev-note">{tr("（本轮没有原文证据）")}</p> : null}
            {bundle.text.evidences.map((e, i) => {
              const expanded = fullCite === i
              const body = expanded ? e.text : e.text.slice(0, 96) + (e.text.length > 96 ? '…' : '')
              return (
                <div className="cite-item" key={e.chunkId + i} id={'cite-' + msgId + '-' + i}>
                  <div className="cite-line">
                    <span className="cite-no">[{i + 1}]</span>{usedCard.indexOf(i + 1) >= 0 ? <span style={{ color: '#0a7d55', fontWeight: 600, margin: '0 4px' }}>{tr("已引用")}</span> : null}{' '}
                    {e.kind === 'user' ? (
                      // 🆕 U4/D29 + v1.2：用户自建文本 —— 标题/来源备注走**专有字段**（不再借用章节字段）
                      <>
                        {tr('用户录入')}{e.title ? ' · ' + e.title : ''}{e.sourceNote ? ' · ' + tr('来源：') + e.sourceNote : ''}
                        <span style={{ color: '#9ca3af' }}>{tr(' · 块 {id} · 用户自建文本 · 权威性低于内置知识库 · 路内分 {score}', { id: e.chunkId, score: e.score.toFixed(4) })}</span>
                      </>
                    ) : (
                      <>
                        {tr('块 {id}', { id: e.chunkId })}
                        <span style={{ color: '#9ca3af' }}>{tr(' · 父块 · 路内分 {score}', { score: e.score.toFixed(4) })}</span>
                      </>
                    )}
                  </div>
                  <Highlight text={body} terms={expanded ? terms : []} />
                  <div className="cite-more" onClick={() => setFullCite(expanded ? null : i)}>
                    {expanded ? tr('收起全文') : tr('展开全文（{n} 字）', { n: e.text.length })}
                  </div>
                </div>
              )
            })}
          </div>
          {failed.length ? (
            <div className="ev-status"><b>!</b><span>{tr('本轮有检索路异常（已降级、不静默）：')}{failed.join('；')}</span></div>
          ) : null}
          <div className="ev-note">{tr('共现关联（非因果）：')}{cooc.length ? cooc.join(' ／ ') : '（无）'}</div>
          <div className="ev-note">{tr('证据档位判据：文本路最像子块余弦 {s} ≥0.6 充足 / 0.4–0.6 部分 / <0.4 不足（阈值未标定）', { s: bundle.highestSimilarity === null ? '（无）' : bundle.highestSimilarity.toFixed(4) })}</div>
        </div>
      ) : null}
    </div>
  )
}

/** 图块外壳（标题 + 计数 + 收起） */
function FigBlock({ cap, count, children }: { cap: string; count: string; children: React.ReactNode }) {
  const [folded, setFolded] = useState(false)
  return (
    <div className="fig-block">
      <div className="fig-head">
        <span className="fig-cap">{cap}</span>
        <span className="fig-count">{count}</span>
        <span className="fig-fold" onClick={() => setFolded((v) => !v)}>{folded ? tr('展开') : tr('收起')}</span>
      </div>
      {folded ? null : <div className="fig-body">{children}</div>}
    </div>
  )
}

/** 三份图；**画不出来就不显示**（F27）—— 三块各自独立显隐，全空才整块不出现（14- C3） */
export function TurnFigures({ bundle, collapsed }: { bundle?: EvidenceBundle | null; collapsed: boolean }) {
  if (!bundle) return null
  if (collapsed) return <div className="fig-collapsed">{tr("三份图已收起（顶栏「展开所有图」可恢复）")}</div>
  const { nodes, links, causalPaths, cooccurrencePaths } = bundle.graph
  const cooc = cooccurrencePaths.map((p) => p.nodes.map((n) => n.name).join(' ↔ '))
  // 方案 D（施工单《15-》§3.3）：树由 bundle 现有数据拼出；返回 null = 不画（尺子闸门 / 素材空 / 单节点）
  const tree = buildTree(bundle)
  const treeCount = treeNodeCount(tree)
  const showSub = nodes.length > 2 && links.length > 0
  const showChain = causalPaths.length > 0
  const showTree = tree !== null && treeCount > 2   // 树节点 ≤2 不画（F27 画不出来就不显示）
  // 🔴 三块**各自独立显隐**（14- C3）：任一块有料就保留，**只有三块全空才整块不出现**（画不出来就不显示，F27）。
  //    放宽后的通路若为 0，子图/树照常显示，不会把整块拖没。
  if (!showSub && !showChain && !showTree && cooc.length === 0) return null
  return (
    <>
      {showSub ? (
        <FigBlock cap={tr("相关实体怎么连")} count={tr("{n} 节点 / {l} 边", { n: nodes.length, l: links.length })}>
          <SubgraphFigure nodes={nodes} links={links} />
          <div className="fig-hint">{tr("节点可拖动摆位置 · 双击节点恢复自动布局 · 滚轮缩放 · 拖动空白处平移")}</div>
          <div className="fig-legend">
            {Object.keys(ENTITY_COLORS_DISPLAY).map((k) => (
              <span className="legend-item" key={k}><i className="legend-color" style={{ background: ENTITY_COLORS_DISPLAY[k] }} />{tr(k as never)}</span>
            ))}
          </div>
        </FigBlock>
      ) : null}
      {showChain || cooc.length ? (
        <FigBlock cap={tr("图上通路（无向）")} count={tr("{n} 条图上通路", { n: causalPaths.length })}>
          {showChain ? <ChainFigure paths={causalPaths} cooc={cooc} /> : <div className="fig-note">{tr("本次未找到图上通路 —— 命中的实体在关系图上没有连通的通路（只走「导致 / 对应」、3~6 节点、无向）。")}</div>}
          {showChain ? <div className="fig-hint">{tr("滚轮缩放 · 拖动平移")}</div> : null}
          {showChain ? <div className="cooc-line"><b>{tr("共现关联（非因果）：")}</b>{cooc.length ? cooc.join(' ／ ') : '（无）'}</div> : null}
        </FigBlock>
      ) : null}
      {showTree ? (
        <FigBlock cap={tr("先查哪个")} count={tr("{d} 层 / {n} 节点", { d: treeDepth(tree), n: treeCount })}>
          <TreeFigure tree={tree} />
          <div className="fig-hint">{tr("从左往右看：根（问题锚点）→ 命中现象 → 原因 → 措施（灰字「现象级」= 该现象的通用措施、未与该原因配对）；本图是知识图谱中与本问题相关的结构与关联，结论仍以正文引用为准 · 滚轮缩放 · 拖动平移")}</div>
        </FigBlock>
      ) : null}
    </>
  )
}

/** 图例色（与引擎一致；此处只需键名与色值） */
export const ENTITY_COLORS_DISPLAY: Record<string, string> = {
  船舶装备: '#1E90FF', 故障现象: '#DC143C', 维修步骤: '#228B22', 故障原因: '#8A2BE2',
  维护项目: '#FF69B4', 注意事项: '#32CD32', 零部件: '#FF8C00',
}
