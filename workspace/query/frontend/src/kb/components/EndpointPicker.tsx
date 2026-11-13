/**
 * 三元组端点选择器（U2）。
 *
 * 🔴 为什么要做成"输入筛选 + 点选"而不是原生 datalist：
 *    教材里有 **32 组 74 行重名实体**，只靠名字会选错 —— 这里**存的是 entityId**。
 * 来源：自建实体（kb 快照）+ 教材实体（沿用现成的 `graph.overview`，qa-core 侧有缓存）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { GraphOverview, UserKbSnapshot } from '../../../../shared/types'
import { graphOverview } from '../../sessions'
import { tr } from '../../lang/provider'

export interface Pickable { id: string; name: string; type: string; origin: 'curated' | 'user' }

interface Props {
  kb: UserKbSnapshot
  value: string
  onChange: (id: string) => void
  placeholder?: string
}

export default function EndpointPicker({ kb, value, onChange, placeholder }: Props) {
  const [all, setAll] = useState<Pickable[] | null>(null)
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    graphOverview()
      .then((g: GraphOverview) => {
        if (alive) setAll(g.entities.map((e) => ({ id: e.entityId, name: e.name, type: e.type, origin: 'curated' as const })))
      })
      .catch(() => {
        if (alive) setAll([])   // 读不到教材就只用自建（**不静默**：调用方会给提示）
      })
    return () => {
      alive = false
    }
  }, [])

  const merged = useMemo<Pickable[]>(() => {
    const mine: Pickable[] = (kb?.entities ?? []).map((e) => ({ id: e.id, name: e.name, type: e.type, origin: 'user' as const }))
    return [...mine, ...(all ?? [])]
  }, [kb, all])

  const picked = merged.find((x) => x.id === value) ?? null
  const q = text.trim()
  const hits = q ? merged.filter((x) => x.name.indexOf(q) >= 0).slice(0, 12) : []

  return (
    <div className="kb-picker" ref={box}>
      <input
        className="kb-input"
        value={open ? text : picked ? picked.name + '（' + picked.type + '）' : value}
        placeholder={placeholder ?? '输入名称筛选，点选结果'}
        onFocus={() => {
          setOpen(true)
          setText('')
        }}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          setOpen(true)
          setText(e.target.value)
        }}
      />
      {open && q ? (
        <div className="kb-picker-list">
          {hits.length === 0 ? <div className="kb-picker-empty">{tr("没有匹配（内置 + 自建都没有）")}</div> : null}
          {hits.map((h) => (
            <div
              key={h.id}
              className="kb-picker-item"
              onMouseDown={(e) => {
                e.preventDefault()
                onChange(h.id)
                setOpen(false)
              }}
            >
              <span className={'kb-badge ' + (h.origin === 'user' ? 'user' : 'book')}>{h.origin === 'user' ? '自建' : '内置'}</span>
              <span className="kb-picker-name">{h.name}</span>
              <span className="kb-picker-meta">{h.type} · {h.id}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
