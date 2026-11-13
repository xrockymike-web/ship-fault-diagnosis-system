/**
 * 目标 5 · ① 知识图谱全貌页（决策 **D27**）
 *
 * 结构照旧版 `knowledge_graph_all.html`：**上方控件行 + 左侧统计栏 + 右侧图区 + 右下缩放**。
 * 数据：qa-core 的 `graph.overview` **一次拉全量**（1463 实体 / 1116 边；渲染进程不碰文件）。
 * 渲染：**D3 v7 + SVG**（照原稿画法；🔴 负责人 2026-10-06 拍板，不要 canvas）。
 * 纪律：**统计全部实时算**（旧版是硬编码假数字）；**筛选/搜索/选中不重跑布局**；**离开页面立即停**。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { GraphOverview } from '../../../shared/types'
import { graphOverview } from '../sessions'
import { entityColor, relationColor, fullGraphSpec, mountGraph, type GraphHandle } from '../viz/graph'
import { tr, useLocale } from '../lang/provider'

export default function GraphPage() {
  const [data, setData] = useState<GraphOverview | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [applied, setApplied] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [relFilter, setRelFilter] = useState('')
  const [active, setActive] = useState<string | null>(null)
  /** 悬停浮层（问题1：全貌页节点无名称）—— 名称 + 类型 + 度数 */
  const [hover, setHover] = useState<{ name: string; type: string; degree: number; x: number; y: number } | null>(null)
  const locale = useLocale()
  const holder = useRef<HTMLDivElement | null>(null)
  const handle = useRef<GraphHandle | null>(null)

  useEffect(() => {
    let alive = true
    graphOverview().then((d) => { if (alive) setData(d) }).catch((e: Error) => { if (alive) setErr(e.message) })
    return () => { alive = false }
  }, [])

  // 挂载/卸载：进页面建图，**离页立即停**（D27）
  useEffect(() => {
    const el = holder.current
    if (!el || !data) return
    const h = mountGraph(el, fullGraphSpec(data.entities, data.triples), (n, x, y) => {
      if (!n) { setHover(null); return }
      const ent = data.entities.find((e) => e.entityId === n.id)
      const rect = el.getBoundingClientRect()
      setHover({ name: n.name, type: n.type, degree: ent ? ent.degree : 0, x: x - rect.left, y: y - rect.top })
    }, (id) => setActive(id))
    handle.current = h
    return () => { h.stop(); handle.current = null }
  }, [data])

  // 筛选 / 搜索 / 选中：**只改可见性与高亮，不重跑布局**
  useEffect(() => {
    const spec: Record<string, unknown> = {}
    spec.visibleRelations = relFilter ? [relFilter] : []
    if (applied.trim()) {
      const q = applied.trim()
      const hit = new Set(data ? data.entities.filter((e) => e.name.indexOf(q) >= 0).map((e) => e.entityId) : [])
      if (data) data.triples.forEach((t) => { if (hit.has(t.subject)) hit.add(t.object); if (hit.has(t.object)) hit.add(t.subject) })
      spec.visibleIds = [...hit]
    } else {
      spec.visibleIds = []
    }
    handle.current?.setSpec(spec as never)
  }, [data, applied, relFilter])

  // 统计（**实时计算**，不是硬编码）
  // U2：**教材与自建分开计数**（教材数不变 = 保护验收判据与论文口径）
  const split = useMemo(() => {
    if (!data) return null
    const book = data.entities.filter((e) => e.origin !== 'user')
    const mine = data.entities.filter((e) => e.origin === 'user')
    return {
      book,
      mine,
      userIds: mine.map((e) => e.entityId),
      bookEdges: data.triples.filter((t) => t.origin !== 'user').length,
      myEdges: data.triples.filter((t) => t.origin === 'user').length,
    }
  }, [data])
  const stats = useMemo(() => {
    if (!data) return null
    const typeCount = new Map<string, number>()
    data.entities.forEach((e) => typeCount.set(e.type, (typeCount.get(e.type) ?? 0) + 1))
    const relCount = new Map<string, number>()
    data.triples.forEach((t) => relCount.set(t.relation, (relCount.get(t.relation) ?? 0) + 1))
    const isolated = data.entities.filter((e) => e.degree === 0).length
    return { typeCount, relCount, isolated }
  }, [data])

  const typeOptions = useMemo(() => (data ? [...new Set(data.entities.map((e) => e.type))].sort() : []), [data])
  const activeEntity = data && active ? data.entities.find((e) => e.entityId === active) ?? null : null

  return (
    <div className="graph-page">
      <div className="graph-toolbar">
        <div className="ctl">
          <label>{tr("实体名称")}:</label>
          <input value={search} placeholder={tr("输入实体名称")} size={18}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') setApplied(search) }} />
          <button className="gbtn primary" onClick={() => setApplied(search)}>{tr("搜索")}</button>
        </div>
        <div className="ctl">
          <label>{tr("实体类型")}:</label>
          <select value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value); handle.current?.setSpec({ visibleTypes: e.target.value ? [e.target.value] : [] }) }}>
            <option value="">{tr("所有类型")}</option>
            {typeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="ctl">
          <label>{tr("关系类型")}:</label>
          <select value={relFilter} onChange={(e) => setRelFilter(e.target.value)}>
            <option value="">{tr("所有类型")}</option>
            {(data ? data.relationTypes : []).map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <button className="gbtn" onClick={() => { setSearch(''); setApplied(''); setTypeFilter(''); setRelFilter(''); setActive(null); handle.current?.setSpec({ visibleIds: [], visibleTypes: [], visibleRelations: [], active: null }) }}>{tr("显示全部")}</button>
        <button className="gbtn" title={tr("只显示用户自建的实体（内置知识库实体仍会作为邻居出现于连线中）")}
          onClick={() => { setSearch(''); setApplied(''); setTypeFilter(''); setRelFilter(''); setActive(null); handle.current?.setSpec({ visibleIds: split ? split.userIds : [], visibleTypes: [], visibleRelations: [], active: null }) }}>
          {tr("只看自建")}{split && split.mine.length > 0 ? (locale === 'en' ? ' (' + split.mine.length + ')' : '（' + split.mine.length + '）') : ''}
        </button>
        <span className="gtip">
          {data && split
            ? tr("实时统计：内置 {a} 实体 / {b} 边 · 自建 {c} 实体 / {d} 边 · 读库 {e} ms", { a: split.book.length, b: split.bookEdges, c: split.mine.length, d: split.myEdges, e: data.loadedMs })
            : (err ? tr("读库失败：") + err : tr("正在读取知识图谱…"))}
        </span>
      </div>
      <div className="graph-main">
        <div className="graph-side">
          <div className="side-sec">
            <h3>{tr("统计信息")}</h3>
            <div className="stats-item"><span>{tr("实体数量（内置）")}:</span><span>{split ? split.book.length : '—'}</span></div>
            <div className="stats-item"><span>{tr("关系数量（内置）")}:</span><span>{split ? split.bookEdges : '—'}</span></div>
            <div className="stats-item"><span>{tr("自建实体")}:</span><span>{split ? split.mine.length : '—'}</span></div>
            <div className="stats-item"><span>{tr("自建关系")}:</span><span>{split ? split.myEdges : '—'}</span></div>
            <div className="stats-item"><span>{tr("孤立实体")}:</span><span>{stats ? stats.isolated : '—'}</span></div>
            {/* 2026-10-19：共现边已迁入 graph 库（cooccurrence_edges = 23,228 行，4.0.1 口径）；此前写的是 24,419 */}
            <div className="stats-item"><span>{tr("共现边（不入图）")}:</span><span>23228</span></div>
          </div>
          <div className="side-sec">
            <h3>{tr("实体类型")}</h3>
            {stats ? [...stats.typeCount.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => (
              <div className="stats-item" key={k}><span><i className="dot" style={{ background: entityColor(k) }} />{k}:</span><span>{v}</span></div>
            )) : null}
          </div>
          <div className="side-sec">
            <h3>{tr("关系类型")}</h3>
            {stats ? [...stats.relCount.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => (
              <div className="stats-item" key={k}><span><i className="dot" style={{ background: relationColor(k) }} />{k}:</span><span>{v}</span></div>
            )) : null}
          </div>
          {activeEntity ? (
            <div className="side-sec">
              <h3>{tr("已选实体")}</h3>
              <div className="tip">{activeEntity.name}<br />{tr("类型")}：{activeEntity.type}<br />{tr("关联边")}：{activeEntity.degree} {tr("条")}<br />ID：{activeEntity.entityId}</div>
            </div>
          ) : null}
        </div>
        <div className="graph-canvas">
          <div className="graph-holder" ref={holder} />
          <div className="zoom-controls">
            <button className="zoom-btn" onClick={() => handle.current?.zoomBy(1.3)}>+</button>
            <button className="zoom-btn" onClick={() => handle.current?.zoomBy(0.7)}>−</button>
            <button className="zoom-btn" onClick={() => handle.current?.resetView()}>⌂</button>
          </div>
          {hover ? (
            <div className="fig-tip" style={{ left: hover.x + 12, top: hover.y + 12 }}>
              <b>{hover.name}</b>
              <span>{tr("类型")}：{hover.type} · {tr("关联边")}：{hover.degree}</span>
            </div>
          ) : null}
        </div>
      </div>
      <div className="graph-footer">{tr("拖动节点摆位置 · 双击节点恢复自动布局 · 右下 ⌂ 一次重排全部 · 滚轮缩放 · 拖动空白处平移 · 点节点高亮邻居")}</div>
    </div>
  )
}
