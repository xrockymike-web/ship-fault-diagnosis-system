/**
 * 目标 5 · 绘图引擎（**d3 v7 + SVG**，照原稿画法）
 *
 * 🆕 2026-10-06 负责人拍板：**不用 canvas，改回原稿的 d3**（"canvas 太丑"）。
 *   因此本文件由 Canvas 版重写为 SVG 版，参数与观感**照旧版**：
 *     · 子图：种子按跳数同心分层（forceRadial）+ forceCenter + collide；节点 r=15/10 按 7 类着色；
 *             标签 12px 粗体**压在圆心**（白描边抗压边）；边按 11 类关系着色 + 箭头（线停在节点边缘）；
 *     · 全貌：照 knowledge_graph_all.html（distance 400 / charge -500 / collide r+15 / alphaDecay .0228）
 *     · 交互：d3.zoom 缩放、拖拽、悬停提示、点击选中高亮邻居
 *   纪律不变：**标签按需**、**预热后自动停**、**离页立即停**、**筛选/搜索/选择不重跑布局**。
 * ⚠️ 性能：1463 节点用 SVG 会有压力 → 已登记 **Q7-12 必须实测**（《技术总纲》§11.2）。
 */
import type { EvidenceBundle } from '../../../shared/types'

declare const d3: any

export const ENTITY_COLORS: Record<string, string> = {
  船舶装备: '#1E90FF', 故障现象: '#DC143C', 维修步骤: '#228B22', 故障原因: '#8A2BE2',
  维护项目: '#FF69B4', 注意事项: '#32CD32', 零部件: '#FF8C00',
}
export const RELATION_COLORS: Record<string, string> = {
  包含: '#FF6B6B', 发生: '#4ECDC4', 导致: '#45B7D1', 对应: '#96CEB4', 使用: '#FECA57',
  适用: '#FF9FF3', 前置: '#54A0FF', 后续: '#5F27CD', 属于: '#00D2D3', 可预防: '#10AC84',
  需注意: '#FF9F43', 关联: '#576574',
}

/** 🆕 英文模式：labels_en 的英文标签 → 与中文同一套颜色（键都小写） */
const ENTITY_COLORS_EN: Record<string, string> = {
  'ship equipment': '#1E90FF', 'fault symptom': '#DC143C', 'repair step': '#228B22',
  'fault cause': '#8A2BE2', 'maintenance item': '#FF69B4', 'precaution': '#32CD32', 'component': '#FF8C00',
}
const RELATION_COLORS_EN: Record<string, string> = {
  contains: '#FF6B6B', occurs: '#4ECDC4', causes: '#45B7D1', 'corresponds to': '#96CEB4', uses: '#FECA57',
  'applies to': '#FF9FF3', precedes: '#54A0FF', follows: '#5F27CD', 'belongs to': '#00D2D3',
  'preventable by': '#10AC84', 'requires attention': '#FF9F43', association: '#576574',
}

/** 中英双 key 取色：先中文表，再英文别名（大小写不敏感），都没有才回退灰 */
export function entityColor(type: string): string {
  const t = String(type ?? '').trim()
  return ENTITY_COLORS[t] || ENTITY_COLORS_EN[t.toLowerCase()] || '#98a2b3'
}
export function relationColor(relation: string): string {
  const r = String(relation ?? '').trim()
  return RELATION_COLORS[r] || RELATION_COLORS_EN[r.toLowerCase()] || '#98a2b3'
}

export interface GNode { id: string; name: string; type: string; hop: number; r: number; /** U2：自建节点画虚线环 */ origin?: 'curated' | 'user' }
/** d3-force 会在节点上挂 x/y/vx/vy —— 供渲染期取值 */
interface SimNode extends GNode { x: number; y: number }
export interface GLink { source: string; target: string; relation: string }
export interface GraphSpec {
  nodes: GNode[]
  links: GLink[]
  layout: 'radial-hop' | 'force'
  /** all = 全部标注（子图）；hop01 = 仅 0/1 跳；top = 度数 Top-18（放大后视野内全部标注） */
  labelMode: 'all' | 'hop01' | 'top'
  visibleTypes?: string[]
  visibleRelations?: string[]
  /** 只显示这些节点（搜索闭包用；空 = 不限制） */
  visibleIds?: string[]
  active?: string | null
}

function safeId(s: unknown): string { return String(s == null ? '' : s).replace(/[^\w\u4e00-\u9fa5]/g, '_') }

/** 标签显示宽度估算（font 12 bold：ASCII≈7px、CJK≈12px）—— 按**宽度**截断，不再按字符数 12 硬切（问题："Main Switchb…"） */
function labelW(s: string): number { let w = 0; for (const ch of s) w += ch.charCodeAt(0) <= 0xff ? 7 : 12; return w }
function truncLabel(s: string, budget: number): string {
  if (labelW(s) <= budget) return s
  let out = ''
  for (const ch of s) { if (labelW(out + ch + '…') > budget) break; out += ch }
  return out + '…'
}
export function markerId(relation: string): string { return 'arw-' + safeId(relation) }

export function subgraphSpec(b: EvidenceBundle, active?: string | null): GraphSpec {
  const nodes: GNode[] = b.graph.nodes.map((n) => ({ id: n.entityId, name: n.name, type: n.type, hop: n.hop, r: n.hop === 0 ? 15 : 10 }))
  const links: GLink[] = b.graph.links.map((l) => ({ source: l.from, target: l.to, relation: l.relation }))
  // 2026-10-27：子图改为**全部节点标注**（问题：21 节点只标 hop≤1，其余裸奔）
  return { nodes, links, layout: 'radial-hop', labelMode: 'all', active: active ?? null }
}

export function fullGraphSpec(
  entities: { entityId: string; name: string; type: string; degree: number; origin?: 'curated' | 'user' }[],
  triples: { subject: string; object: string; relation: string }[],
): GraphSpec {
  const nodes: GNode[] = entities.map((e) => ({ id: e.entityId, name: e.name, type: e.type, hop: 1, r: e.degree >= 4 ? 15.5 : 10, origin: e.origin }))
  const links: GLink[] = triples.map((t) => ({ source: t.subject, target: t.object, relation: t.relation }))
  return { nodes, links, layout: 'force', labelMode: 'top' }
}

export interface GraphHandle {
  stop(): void
  redraw(): void
  setSpec(patch: Partial<GraphSpec>): void
  zoomBy(k: number): void
  resetView(): void
}

/** 在容器里用 d3 画一张 SVG 图；返回句柄（**离开页面务必 stop()**） */
export function mountGraph(
  container: HTMLElement,
  spec: GraphSpec,
  onHover?: (n: GNode | null, x: number, y: number) => void,
  onSelect?: (id: string | null) => void,
): GraphHandle {
  let cur: GraphSpec = spec
  const W = cur.layout === 'radial-hop' ? 1000 : Math.max(560, container.clientWidth || 900)
  const H = cur.layout === 'radial-hop' ? 780 : Math.max(320, container.clientHeight || 560)
  const nodes = cur.nodes.map((n) => Object.assign({}, n))
  const links = cur.links.map((l) => Object.assign({}, l))
  const byId = new Map<string, GNode>(nodes.map((n) => [n.id, n]))
  const rels: string[] = []
  links.forEach((l) => { if (rels.indexOf(l.relation) < 0) rels.push(l.relation) })
  const deg = new Map<string, number>()
  links.forEach((l) => {
    deg.set(l.source, (deg.get(l.source) ?? 0) + 1)
    deg.set(l.target, (deg.get(l.target) ?? 0) + 1)
  })
  const topIds = new Set([...deg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18).map((e) => e[0]))
  const labelBudget = cur.layout === 'radial-hop' ? 140 : 120
  /** 问题1 修复用：放大（k≥1.4）且视野内节点 ≤80 时，视野内**全部节点标注** */
  let labelAllInZoom = false
  let zoomK = 1
  let zoomX = 0
  let zoomY = 0

  // 问题2 附带：初始位不再挤在原点螺旋（首轮会看到左上角一坨巨圆）——黄金角铺开，确定性、首轮即圆散布
  nodes.forEach((n, i) => {
    const m = n as unknown as { x?: number; y?: number }
    const a = i * 2.39996322972865332
    const rr = Math.min(W, H) * 0.0155 * Math.sqrt(i + 0.5)
    m.x = W / 2 + rr * Math.cos(a) * (W / Math.max(1, H))
    m.y = H / 2 + rr * Math.sin(a)
  })

  container.innerHTML = ''
  const svg = d3.select(container).append('svg')
    .attr('viewBox', '0 0 ' + W + ' ' + H)
    .attr('width', '100%')
    .style('display', 'block')
    .style('height', 'auto')
    .style('max-width', W + 'px')
    .style('max-height', H + 'px')
  const g = svg.append('g')
  const zoom = d3.zoom().scaleExtent([0.2, 4]).on('zoom', (e: { transform: { k: number; x: number; y: number; toString(): string } }) => {
    g.attr('transform', e.transform)
    zoomK = e.transform.k; zoomX = e.transform.x; zoomY = e.transform.y
    // 问题1 修复：放大到视野内节点不多时，视野内节点全部标注（否则 Top-18 之外永远无名）
    if (cur.labelMode === 'top') {
      let cnt = 0
      if (zoomK >= 1.4) {
        for (const n of nodes) {
          if (!visible(n)) continue
          const m = n as unknown as { x: number; y: number }
          const x = m.x * zoomK + zoomX, y = m.y * zoomK + zoomY
          if (x >= 0 && x <= W && y >= 0 && y <= H) { cnt++; if (cnt > 80) break }
        }
      }
      const next = zoomK >= 1.4 && cnt <= 80
      if (next !== labelAllInZoom) { labelAllInZoom = next; refresh() }
    }
  })
  svg.call(zoom)
  // 箭头：线停在节点边缘 + 手绘三角（markerUnits=userSpaceOnUse 修掉旧版被圆盖住/随线宽缩放的问题）
  const defs = svg.append('defs')
  rels.forEach((r) => {
    defs.append('marker')
      .attr('id', markerId(r))
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 10).attr('refY', 0)
      .attr('markerWidth', 7).attr('markerHeight', 7)
      .attr('markerUnits', 'userSpaceOnUse').attr('orient', 'auto')
      .append('path').attr('d', 'M0,-5L10,0L0,5').attr('fill', relationColor(r))
  })

  const link = g.append('g').selectAll('line').data(links).enter().append('line')
    .attr('stroke', (d: GLink) => relationColor(d.relation))
    .attr('stroke-width', cur.layout === 'radial-hop' ? 1.2 : 1.5)
    .attr('stroke-opacity', 0.55)
    .attr('marker-end', (d: GLink) => 'url(#' + markerId(d.relation) + ')')
  const linkLabel = g.append('g').selectAll('text').data(links).enter().append('text')
    .attr('font-size', cur.layout === 'radial-hop' ? 10 : 8).attr('fill', '#666').attr('text-anchor', 'middle')
    .text((d: GLink) => d.relation)
  const node = g.append('g').selectAll('circle').data(nodes).enter().append('circle')
    .attr('r', (d: GNode) => d.r)
    .attr('fill', (d: GNode) => entityColor(d.type))
    // U2：自建节点用**虚线环**区分（教材节点保持原样：白边实线）
    .attr('stroke', (d: GNode) => (d.origin === 'user' ? '#2f6bff' : '#ffffff'))
    .attr('stroke-width', (d: GNode) => (d.origin === 'user' ? 2 : 1.5))
    .attr('stroke-dasharray', (d: GNode) => (d.origin === 'user' ? '3 2' : null))
    .style('cursor', 'pointer')
  const label = g.append('g').selectAll('text').data(nodes).enter().append('text')
    .attr('font-size', cur.layout === 'radial-hop' ? 12 : 10).attr('font-weight', 'bold')
    .attr('fill', '#1f2329').attr('text-anchor', 'middle')
    .attr('paint-order', 'stroke').attr('stroke', '#ffffff').attr('stroke-width', 3)
    .attr('stroke-linejoin', 'round')
    .style('pointer-events', 'none')
    .text((d: GNode) => truncLabel(d.name, labelBudget))

  function visible(n: GNode): boolean {
    const ids = cur.visibleIds
    if (ids && ids.length > 0 && ids.indexOf(n.id) < 0) return false
    const t = cur.visibleTypes
    return !t || t.length === 0 || t.indexOf(n.type) >= 0
  }
  function neighborsOf(id: string | null | undefined): Set<string> {
    const s = new Set<string>()
    if (!id) return s
    s.add(id)
    links.forEach((l) => {
      if (l.source === id) s.add(l.target)
      if (l.target === id) s.add(l.source)
    })
    return s
  }
  /** d3.forceLink 初始化后会把 `source/target` 由 **id 字符串**换成 **节点对象** —— 两种形态都要能取到 */
  function nodeOf(endpoint: unknown): GNode | undefined {
    if (endpoint == null) return undefined
    if (typeof endpoint === 'string') return byId.get(endpoint)
    return endpoint as GNode
  }
  function simOf(endpoint: unknown): { x: number; y: number; r: number } | undefined {
    const n = nodeOf(endpoint) as unknown as { x?: number; y?: number; r?: number } | undefined
    if (!n || typeof n.x !== 'number' || typeof n.y !== 'number') return undefined
    return { x: n.x, y: n.y, r: typeof n.r === 'number' ? n.r : 10 }
  }
  function endsOk(d: GLink): boolean {
    const a = nodeOf(d.source), b = nodeOf(d.target)
    return Boolean(a && b && visible(a) && visible(b))
  }

  function refresh(): void {
    const nb = neighborsOf(cur.active)
    const on = Boolean(cur.active)
    node.style('display', (d: GNode) => (visible(d) ? null : 'none'))
      .attr('fill-opacity', (d: GNode) => (on && !nb.has(d.id) ? 0.16 : 1))
      .attr('stroke', (d: GNode) => (d.id === cur.active ? '#1f2329' : '#ffffff'))
      .attr('stroke-width', (d: GNode) => (d.id === cur.active ? 2.6 : 1.5))
    label.style('display', (d: GNode) => {
      if (!visible(d)) return 'none'
      if (cur.labelMode === 'all') return null
      if (cur.labelMode === 'hop01') return d.hop <= 1 || d.id === cur.active ? null : 'none'
      return topIds.has(d.id) || nb.has(d.id) || labelAllInZoom ? null : 'none'
    }).attr('fill-opacity', (d: GNode) => (on && !nb.has(d.id) ? 0.3 : 1))
    link.style('display', (d: GLink) => (endsOk(d) ? null : 'none'))
      .attr('stroke-opacity', (d: GLink) => {
        const a = nodeOf(d.source), b = nodeOf(d.target)
        return on && !(a && b && nb.has(a.id) && nb.has(b.id)) ? 0.08 : 0.55
      })
    linkLabel.style('display', (d: GLink) => (endsOk(d) ? null : 'none'))
  }
  function draw(): void {
    link.each(function (this: SVGLineElement, d: GLink) {
      const a = simOf(d.source), b = simOf(d.target)
      if (!a || !b) return
      const dx = b.x - a.x, dy = b.y - a.y
      const dd = Math.hypot(dx, dy) || 1
      const ux = dx / dd, uy = dy / dd
      d3.select(this)
        .attr('x1', a.x + ux * (a.r + 2)).attr('y1', a.y + uy * (a.r + 2))
        .attr('x2', b.x - ux * (b.r + 9)).attr('y2', b.y - uy * (b.r + 9))
    })
    linkLabel
      .attr('x', (d: GLink) => { const a = simOf(d.source), b = simOf(d.target); return a && b ? (a.x + b.x) / 2 : 0 })
      .attr('y', (d: GLink) => { const a = simOf(d.source), b = simOf(d.target); return a && b ? (a.y + b.y) / 2 - 3 : 0 })
    node.attr('cx', (d: SimNode) => d.x).attr('cy', (d: SimNode) => d.y)
    // 子图（radial-hop）：标签移到圆点**下方**（不压住自己的圆）；全貌页维持压圆心的原稿观感
    label.attr('x', (d: SimNode) => d.x).attr('y', (d: SimNode) => (cur.layout === 'radial-hop' ? d.y + d.r + 13 : d.y + 4))
  }

  /** 视野自适应内容（把节点范围铺满画布 —— 否则 40 个节点会挤在正中一小团） */
  function fitToContent(pad = 46): void {
    const xs = nodes.map((n) => (n as unknown as { x: number }).x)
    const ys = nodes.map((n) => (n as unknown as { y: number }).y)
    const minX = Math.min(...xs), maxX = Math.max(...xs)
    const minY = Math.min(...ys), maxY = Math.max(...ys)
    const k = Math.min((W - pad * 2) / Math.max(1, maxX - minX), (H - pad * 2) / Math.max(1, maxY - minY), 3)
    const tx = W / 2 - ((minX + maxX) / 2) * k
    const ty = H / 2 - ((minY + maxY) / 2) * k
    svg.call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(Math.max(0.2, k)))
  }

  const linkF = d3.forceLink(links).id((d: GNode) => d.id)
  let sim: any
  if (cur.layout === 'radial-hop') {
    // 问题2 修复：hop 分层**同心圆环**——种子（hop0）不再挤在圆心一个点上：
    //   · 种子按数量给内环半径；≥4 个时**双半径编织**（奇偶 ±24），相邻种子的标签错开一整格；
    //   · hop1 / hop2 依次外环；配合按宽度截断的标签（见 labelBudget），环上相邻标签不再叠字。
    const seedCount = nodes.filter((d: GNode) => d.hop <= 0).length
    const seedR = seedCount <= 1 ? 0 : Math.min(150, 84 + seedCount * 8)
    const ring1 = seedR + 125
    const ring2 = ring1 + 118
    const seedNo = new Map<string, number>()
    let sno = 0
    nodes.forEach((d: GNode) => { if (d.hop <= 0) seedNo.set(d.id, sno++) })
    const ringR = (d: GNode): number => {
      if (d.hop > 0) return d.hop === 1 ? ring1 : ring2
      if (seedR === 0) return 0
      return seedR + ((seedNo.get(d.id) ?? 0) % 2 === 0 ? -26 : 26)
    }
    linkF.distance((l: { source: GNode; target: GNode }) => 90 + (l.source.hop + l.target.hop) * 10).strength(0.18)
    sim = d3.forceSimulation(nodes)
      .force('link', linkF)
      .force('charge', d3.forceManyBody().strength(-130))
      .force('radial', d3.forceRadial(ringR, W / 2, H / 2).strength(0.92))
      // 标签感知碰撞：标签越宽，节点间最小间距越大（按显示宽度，不是字符数）
      .force('collide', d3.forceCollide().radius((d: GNode) => d.r + 12 + Math.min(45, labelW(truncLabel(d.name, labelBudget)) * 0.3)))
  } else {
    linkF.distance(400)
    sim = d3.forceSimulation(nodes)
      .force('link', linkF)
      .force('charge', d3.forceManyBody().strength(-500))
      .force('collision', d3.forceCollide().radius((d: GNode) => d.r + 15))
      .alphaDecay(0.0228)
      .velocityDecay(0.8)
  }
  // ⚠️ Q7-12 实测：1463 节点每帧写 1116 线 + 1463 圆 → 布局期仅 ~16 fps。
  // 便宜优化：**布局期每 3 个 tick 才写一次 DOM**（观感几乎无差），终态由 'end' 精确补一次。
  let tickN = 0
  let dragging = false
  // 拖动中**每帧都写**（要跟手）；平时每 3 个 tick 写一次（Q7-12 节流）
  sim.on('tick', () => { tickN++; if (dragging || tickN % 3 === 0) draw() })
  sim.on('end', () => { draw(); refresh(); fitToContent() })
  // 预热 + 首帧贴合：子图（节点少）同步跑 150 tick，进画布即"结算态"（不拍到散团/叠字）；
  // 全貌页（1463 节点）跳过同步预热（太贵），由黄金角初始位 + 首帧 fit 兜底，'end' 再精确贴合。
  if (cur.layout === 'radial-hop') { for (let i = 0; i < 150; i++) sim.tick() }
  draw()
  refresh()
  fitToContent()

  // 目标 5：**节点拖拽**（子图与全貌页都有）
  //   · 拖到哪**就停在哪**（保留 fx/fy，不弹回）；
  //   · **双击节点**释放它（恢复自动布局）；右下 ⌂ 一次释放全部并重排；
  //   · 拖动过就不触发"点选"，避免拖完误高亮邻居。
  let moved = false
  const drag = d3.drag()
    .on('start', (event: { active: number }, d: GNode) => {
      moved = false
      dragging = true
      const n = d as unknown as { x: number; y: number; fx?: number | null; fy?: number | null }
      if (!event.active) sim.alphaTarget(0.25).restart()
      n.fx = n.x
      n.fy = n.y
    })
    .on('drag', (event: { x: number; y: number }, d: GNode) => {
      moved = true
      const n = d as unknown as { fx?: number | null; fy?: number | null }
      n.fx = event.x
      n.fy = event.y
      draw()
    })
    .on('end', (event: { active: number }) => {
      dragging = false
      if (!event.active) sim.alphaTarget(0)
    })
  node
    .style('cursor', 'grab')
    .call(drag)
    .on('mouseover', function (this: SVGCircleElement, e: MouseEvent, d: GNode) { d3.select(this).style('cursor', 'grab'); if (onHover) onHover(d, e.clientX, e.clientY) })
    .on('mousemove', (e: MouseEvent, d: GNode) => { if (onHover) onHover(d, e.clientX, e.clientY) })
    .on('mouseout', () => { if (onHover) onHover(null, 0, 0) })
    .on('dblclick', (_e: MouseEvent, d: GNode) => {
      // 双击释放这个节点（恢复自动布局）
      const n = d as unknown as { fx?: number | null; fy?: number | null }
      n.fx = null
      n.fy = null
      sim.alpha(0.5).restart()
    })
    .on('click', (_e: MouseEvent, d: GNode) => {
      if (moved) return
      cur.active = cur.active === d.id ? null : d.id
      refresh()
      if (onSelect) onSelect(cur.active ?? null)
    })

  return {
    stop(): void { if (sim) sim.stop() },
    redraw(): void { draw(); refresh() },
    setSpec(patch: Partial<GraphSpec>): void { cur = Object.assign({}, cur, patch) as GraphSpec; refresh() },
    zoomBy(k: number): void { svg.transition().call(zoom.scaleBy, k) },
    resetView(): void {
      // ⌂ = 回到初始视角 **并** 释放所有手动摆放的节点、重新自动布局
      nodes.forEach((n) => {
        const m = n as unknown as { fx?: number | null; fy?: number | null }
        m.fx = null
        m.fy = null
      })
      sim.alpha(0.6).restart()
      setTimeout(() => fitToContent(), 60) // 重排后视野重新自适应（等第一帧坐标出来）
    },
  }
}
