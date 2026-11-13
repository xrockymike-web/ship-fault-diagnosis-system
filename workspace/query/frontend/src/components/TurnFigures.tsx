/**
 * 目标 5 · 三份图（回答下方依次排开，默认展开）
 *   ① 子图（种子按跳数同心分层）② 路径图（**图上通路·无向** + 共现一行）③ 树（从左往右）
 * 🆕 2026-10-06 负责人拍板：**不用 canvas，改回原稿的 d3（SVG）**。
 */
import { useEffect, useRef, useState } from 'react'
import type { GraphPath, SubgraphLink, SubgraphNode } from '../../../shared/types'
import { treeLeafCount, type TNode } from '../../../shared/build-tree'

// 🔴 树的**真源**已迁 `shared/build-tree.ts`（施工单 15- §4.10）：
//    ① 界面与问答档案(H5) 共用一份逻辑；② 新增「问题画像（正则）→ 展开策略」。
//    此处 re-export，保持 EvidencePanel 既有 import 路径（'./TurnFigures'）不变。
export { buildTree, treeDepth, treeLeafCount, treeNodeCount } from '../../../shared/build-tree'
export type { TNode } from '../../../shared/build-tree'

import { entityColor, relationColor, mountGraph, subgraphSpec } from '../viz/graph'
import { tr } from '../lang/provider'

declare const d3: any

/** 按实际内容收紧缩放框（文字不被空白拖小） */
function tightViewBox(svg: unknown, g: unknown, pad: number): void {
  try {
    const bb = (g as { node: () => { getBBox: () => { x: number; y: number; width: number; height: number } } }).node().getBBox()
    if (bb && bb.width > 0 && bb.height > 0) {
      (svg as { attr: (k: string, v: string) => void }).attr(
        'viewBox',
        (bb.x - pad) + ' ' + (bb.y - pad) + ' ' + (bb.width + pad * 2) + ' ' + (bb.height + pad * 2),
      )
    }
  } catch { /* 无 DOM 测量时忽略 */ }
}

// ---------------------------------------------------------------------------
// ① 子图（d3 力导向 + 按跳数分层，照原稿观感）
// ---------------------------------------------------------------------------
export function SubgraphFigure({ nodes, links, height = 420 }: { nodes: SubgraphNode[]; links: SubgraphLink[]; height?: number }) {
  const holder = useRef<HTMLDivElement | null>(null)
  const [tip, setTip] = useState<{ name: string; type: string; x: number; y: number } | null>(null)
  useEffect(() => {
    const el = holder.current
    if (!el) return
    const spec = subgraphSpec({ graph: { nodes, links } } as never, null)
    const h = mountGraph(el, spec, (n, x, y) => {
      if (!n) { setTip(null); return }
      const r = el.getBoundingClientRect()
      setTip({ name: n.name, type: n.type, x: x - r.left, y: y - r.top })
    })
    return () => h.stop()
  }, [nodes, links])
  return (
    <div className="fig-svg" ref={holder} style={{ position: 'relative', minHeight: height }}>
      {tip ? (
        <div className="fig-tip" style={{ left: tip.x + 12, top: tip.y + 12 }}>
          <b>{tip.name}</b>
          <span>{tr('类型')}：{tip.type}</span>
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ② 路径图（图上通路·无向）—— d3 画 SVG
//
// 🔴 **Neo4j Bloom / 胶囊风格**（2026-10-11 负责人选定为模板二，静态对比稿见
//    data/runtime/temp/ui-shots/path-v{1,2,3}.png；定案见《交接/14-》§3.5 R4）：
//    · 节点 = **圆角胶囊**，宽度 = 文字宽 + 边距（**根治旧版「文字压在小圆上、线穿字」**）；
//    · 连线 = 胶囊之间的**水平直线**，两端接在胶囊边缘；
//    · 关系名 = **白色圆角牌骑在线上**，边框用该关系在子图里的同款颜色（Neo4j 的 edge label 做法）；
//    · 节点填色 = 实体类型色的 16% 淡底 + 类型色描边（与子图/全貌页同一套 ENTITY_COLORS）；
//    · **无箭头**（通路无向；实测方向正确的「导致→导致」长链全图为 0 条）；
//    · 每行左对齐 + 行首序号 + 保留 d3.zoom（滚轮缩放 / 拖动平移）。
// ---------------------------------------------------------------------------
export function ChainFigure({ paths, cooc }: { paths: GraphPath[]; cooc: string[] }) {
  const holder = useRef<HTMLDivElement | null>(null)
  // 图例：只列这条链上真出现过的类型（与子图块同款 CSS）
  const types = Array.from(new Set(paths.flatMap((p) => p.nodes.map((n) => n.type))))
  useEffect(() => {
    const el = holder.current
    if (!el || paths.length === 0) return
    const ROW = 64, GAP = 76, PAD = 24, RH = 34, PAD_L = 46, PAD_T = 16
    const wOf = (s: string) => s.length * 13
    const widths = paths.map((p) => p.nodes.map((n) => wOf(n.name) + PAD))
    const maxChain = Math.max(0, ...widths.map((ws) => ws.reduce((x, y) => x + y, 0) + GAP * Math.max(0, ws.length - 1)))
    const W = Math.max(520, maxChain + PAD_L + 20)
    const H = paths.length * ROW + 40
    const tint = (hex: string, alpha: number): string => {
      const n = parseInt(hex.slice(1), 16)
      return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')'
    }
    el.innerHTML = ''
    const svg = d3.select(el).append('svg')
      .attr('viewBox', '0 0 ' + W + ' ' + H).attr('width', '100%')
      .style('display', 'block').style('height', 'auto').style('max-width', W + 'px')
    const g = svg.append('g')
    svg.call(d3.zoom().scaleExtent([0.2, 4]).on('zoom', (e: { transform: unknown }) => { g.attr('transform', e.transform) }))
    paths.forEach((p, ri) => {
      const y = PAD_T + ri * ROW + 34
      g.append('text').attr('x', 6).attr('y', y + 4).attr('font-size', 13).attr('fill', '#98a2b3').text(ri + 1 + '.')
      const ws = widths[ri]
      const L: number[] = [], R: number[] = []
      let x = PAD_L
      p.nodes.forEach((_n, i) => { L.push(x); R.push(x + ws[i]); x += ws[i] + GAP })
      // 先画线再画关系牌（牌压在线上，线从牌下穿过去也不影响观感）
      p.edges.forEach((e, i) => {
        if (i >= L.length - 1) return
        g.append('line').attr('x1', R[i]).attr('y1', y).attr('x2', L[i + 1]).attr('y2', y)
          .attr('stroke', '#98a2b3').attr('stroke-width', 1.8)
        const rel = e.relation || '关联'
        const xm = (R[i] + L[i + 1]) / 2
        const tw = rel.length * 11.5 + 16
        const gp = g.append('g').attr('transform', 'translate(' + xm + ',' + y + ')')
        gp.append('rect').attr('x', -tw / 2).attr('y', -11).attr('width', tw).attr('height', 22).attr('rx', 11)
          .attr('fill', '#fff').attr('stroke', relationColor(rel)).attr('stroke-width', 1.4)
        gp.append('text').attr('text-anchor', 'middle').attr('y', 4).attr('font-size', 11.5)
          .attr('fill', '#24292f').text(rel)
      })
      // 胶囊节点：宽度 = 文字宽 + 边距（文字永不溢出）
      p.nodes.forEach((n, i) => {
        const w = ws[i]
        const color = entityColor(n.type)
        g.append('rect').attr('x', L[i]).attr('y', y - RH / 2).attr('width', w).attr('height', RH).attr('rx', RH / 2)
          .attr('fill', tint(color, 0.16)).attr('stroke', color).attr('stroke-width', 1.6)
        g.append('text').attr('x', L[i] + w / 2).attr('y', y + 4.5).attr('text-anchor', 'middle')
          .attr('font-size', 13).attr('font-weight', 700).attr('fill', '#1f2329').text(n.name)
      })
    })
    // 不收紧 viewBox：保持 W×H 自然尺寸，配合 max-width 保证只缩不放
    return () => { el.innerHTML = '' }
  }, [paths, cooc])
  return (
    <>
      <div className="fig-svg" ref={holder} />
      {types.length > 0 ? (
        <div className="fig-legend">
          {types.map((ty) => (
            <span className="legend-item" key={ty}>
              <i className="legend-color" style={{ background: entityColor(ty) }} />{tr(ty as never)}
            </span>
          ))}
        </div>
      ) : null}
    </>
  )
}
// ---------------------------------------------------------------------------
// ③ 树（先查哪个）—— **方案 D · 融合阶梯**（施工单《15-诊断树重构方案D》§3.3）
//
// 🔴 六步：① 尺子闸门（evidenceLevel = insufficient → 不出树，挡「漫无目的」）
//         ② 问题锚点做根（文本命中 → 子图内类型先验+语义分 → 无邻接边回退到有边的 → 再退度最高）
//         ③ 因果主干：诊断路径**按现象分组**（修跨现象混挂），根—现象连线取子图真实关系名
//         ④ 措施三层：p.measures 真配对 → 子图里「现象级」**每现象只挂一轮** → 没有就留空
//         ⑤ 结构补层：深度 <3 才补，visited=occupied（根与因果层全排除），每层 ≤4、总深 ≤4、共现不进树
//         ⑥ 三条不画：尺子不足 / 节点≤1 / 素材全空
// 零契约改动：输入全部来自 bundle（seeds / nodes / links / paths / question），不碰后端、不碰提示词。
// ---------------------------------------------------------------------------

// 🔴 2026-10-11：构建逻辑（方案 D + 问题画像）已迁 `shared/build-tree.ts`；此处只负责**画**（从左往右 + 层距自适应）。
export function TreeFigure({ tree }: { tree: TNode | null }) {
  const holder = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = holder.current
    if (!el || !tree) return
    const leaves = Math.max(1, treeLeafCount(tree))
    const W_TREE = 1000, H_TREE = Math.min(700, Math.max(180, leaves * 46 + 60))
    el.innerHTML = ''
    const svg = d3.select(el).append('svg')
      .attr('viewBox', '0 0 ' + W_TREE + ' ' + H_TREE).attr('width', '100%')
      .style('display', 'block').style('height', 'auto').style('max-width', W_TREE + 'px')
    const g = svg.append('g')
    svg.call(d3.zoom().scaleExtent([0.2, 4]).on('zoom', (e: { transform: unknown }) => { g.attr('transform', e.transform) }))
    // 🔴 必须显式给 children 访问器：我们的字段叫 kids，d3.hierarchy 默认找 children
    const h = d3.hierarchy(tree, (d: TNode) => d.kids)
    d3.tree().size([H_TREE - 70, W_TREE - 300])(h)
    // —— 层宽自适应（修「第 4 层右侧长节点名压住措施节点」叠字，2026-10-11 追加）——
    // 旧版把各层**等距**排布（4 层 ≈ 233px 一层），而标签单行不截断：最宽的
    // 「整定电阻的滑动触头烧坏、锈蚀、接触不良或电阻烧断   0.666」≈340px > 层距 → 压住下一层。
    // 现改为：每层 x 间距 = 上一层最宽标签的**估算右缘** + 呼吸位（26），另设最小间距 170
    // 保证短标签层不显拥挤；文字仍单行不截断、内容一字不改。
    const labelOf = (d: { data: TNode }): string => d.data.name + (d.data.score ? '   ' + d.data.score : '')
    const estW = (s: string): number => {
      let w = 0
      for (const ch of s) w += ch.charCodeAt(0) <= 0xff ? 6.6 : 12   // font-size 12 bold：ASCII≈6.6px、全角≈12px
      return w
    }
    const layerNeed: number[] = []
    h.each((d: { depth: number; data: TNode }) => {
      const off = d.depth === 0 ? 20 : 15                             // 文字起点 = 圆半径 + 5
      const need = off + estW(labelOf(d)) + 26
      if (need > (layerNeed[d.depth] || 0)) layerNeed[d.depth] = need
    })
    const X: number[] = [0]
    for (let d = 1; d < layerNeed.length; d++) X.push(X[d - 1] + Math.max(layerNeed[d - 1], 170))
    const xOf = (d: { depth: number }): number => (X[d.depth] || 0) + 20
    g.append('g').selectAll('path').data(h.links()).enter().append('path')
      .attr('fill', 'none').attr('stroke', '#999').attr('stroke-opacity', 0.6).attr('stroke-width', 2)
      .attr('d', d3.linkHorizontal().x((d: { depth: number }) => xOf(d)).y((d: { x: number }) => d.x + 30))
    g.append('g').selectAll('text').data(h.links()).enter().append('text')
      .attr('font-size', 10).attr('fill', '#666').attr('text-anchor', 'middle')
      .attr('x', (d: { source: { depth: number }; target: { depth: number } }) => (xOf(d.source) + xOf(d.target)) / 2)
      .attr('y', (d: { source: { x: number }; target: { x: number } }) => (d.source.x + d.target.x) / 2 + 26)
      .text((d: { target: { data: TNode } }) => (d.target.data.rel ? tr(d.target.data.rel as never) : ''))
    const node = g.append('g').selectAll('g').data(h.descendants()).enter().append('g')
      .attr('transform', (d: { depth: number; x: number }) => 'translate(' + xOf(d) + ',' + (d.x + 30) + ')')
      .style('cursor', 'pointer')
    node.append('circle')
      .attr('r', (d: { depth: number }) => (d.depth === 0 ? 15 : 10))
      .attr('fill', (d: { data: TNode }) => ((d.data.type === '未配对' || d.data.type === 'unpaired') ? '#999' : entityColor(d.data.type)))
    node.append('text').attr('dy', 4)
      .attr('x', (d: { depth: number }) => (d.depth === 0 ? 20 : 15)).attr('text-anchor', 'start')
      .attr('font-size', 12).attr('font-weight', 'bold').attr('fill', '#1f2329')
      .text((d: { data: TNode }) => tr(d.data.name as never) + (d.data.score ? '   ' + d.data.score : ''))
    tightViewBox(svg, g, 16)
    return () => { el.innerHTML = '' }
  }, [tree])
  return <div className="fig-svg" ref={holder} />
}
