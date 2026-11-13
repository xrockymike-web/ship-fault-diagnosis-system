import { useEffect, useRef, useState } from 'react'
import type { Session } from '../types'
import { formatListTime } from '../storage'
import { tr } from '../lang/provider'

interface Props {
  sessions: Session[]
  activeId: string
  renamingId: string | null
  /** 折叠态（§15.2 缺口 9），由 App 持有并持久化 */
  collapsed: boolean
  onToggleCollapse: () => void
  /** 目标 5 · ①：页面切换（问答 / 知识图谱）；U2 追加「知识管理」 */
  page: 'chat' | 'graph' | 'knowledge'
  onPage: (p: 'chat' | 'graph' | 'knowledge') => void
  onNew: () => void
  onSelect: (id: string) => void
  onStartRename: (id: string) => void
  onCommitRename: (id: string, title: string) => void
  onCancelRename: () => void
  /** 点 ✕ 只"请求"删除 —— 真正的删除由 App 的应用内确认浮层执行（不再用原生 window.confirm） */
  onAskDelete: (s: Session) => void
}

export default function Sidebar({
  sessions,
  activeId,
  renamingId,
  collapsed,
  onToggleCollapse,
  page,
  onPage,
  onNew,
  onSelect,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onAskDelete,
}: Props) {
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renamingId && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [renamingId])

  const startRename = (s: Session) => {
    setDraft(s.title)
    onStartRename(s.id)
  }

  // 折叠态：只留一条窄栏（品牌图标 + 展开按钮 + 新会话）
  if (collapsed) {
    return (
      <aside className="sidebar rail">
        <button className="btn-collapse" onClick={onToggleCollapse} title={tr("展开侧边栏")}>
          »
        </button>
        <img
          className="brand-icon rail-brand"
          src={import.meta.env.BASE_URL + 'assets/anchor.svg'}
          alt="船舶故障诊断系统"
        />
        <button className="btn-new-rail" onClick={onNew} title={tr("新会话")}>
          ＋
        </button>
        <button className={`rail-nav ${page === 'chat' ? 'on' : ''}`} onClick={() => onPage('chat')} title={tr("故障问答")}>
          💬
        </button>
        <button className={`rail-nav ${page === 'graph' ? 'on' : ''}`} onClick={() => onPage('graph')} title={tr("知识图谱")}>
          🕸
        </button>
        <button className={`rail-nav ${page === 'knowledge' ? 'on' : ''}`} onClick={() => onPage('knowledge')} title={tr("知识管理")}>
          📚
        </button>
      </aside>
    )
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <img className="brand-icon" src={import.meta.env.BASE_URL + 'assets/anchor.svg'} alt="" />
        <span className="brand-name">{tr("船舶故障诊断系统")}</span>
        <button className="btn-collapse" onClick={onToggleCollapse} title={tr("折叠侧边栏")}>
          «
        </button>
      </div>

      <button className="btn-new" onClick={onNew}>
        <span className="btn-new-plus">＋</span>{tr("新会话")}</button>

      {/* 目标 5 · ①：两个页面切换（问答 / 知识图谱） */}
      <div className="side-nav">
        <div className={`side-nav-item ${page === 'chat' ? 'active' : ''}`} onClick={() => onPage('chat')}>
          <span className="side-nav-ico">💬</span>{tr("故障问答")}</div>
        <div className={`side-nav-item ${page === 'graph' ? 'active' : ''}`} onClick={() => onPage('graph')}>
          <span className="side-nav-ico">🕸</span>{tr("知识图谱")}</div>
        <div className={`side-nav-item ${page === 'knowledge' ? 'active' : ''}`} onClick={() => onPage('knowledge')}>
          <span className="side-nav-ico">📚</span>{tr("知识管理")}</div>
      </div>

      <div className="session-list">
        <div className="session-list-label">{tr("对话历史")}</div>
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`session-item ${s.id === activeId && page === 'chat' ? 'active' : ''}`}
            onClick={() => onSelect(s.id)}
            onDoubleClick={() => startRename(s)}
          >
            {renamingId === s.id ? (
              <input
                ref={inputRef}
                className="session-rename-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onBlur={() => onCommitRename(s.id, draft)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onCommitRename(s.id, draft)
                  if (e.key === 'Escape') onCancelRename()
                }}
              />
            ) : (
              <>
                <div className="session-item-main">
                  <span className="session-title">{s.title}</span>
                  <span className="session-time">{formatListTime(s.updatedAt)}</span>
                </div>
                <button
                  className="session-del"
                  title={tr("删除会话")}
                  onClick={(e) => {
                    e.stopPropagation()
                    onAskDelete(s)
                  }}
                >
                  ✕
                </button>
              </>
            )}
          </div>
        ))}
      </div>

      <div className="sidebar-footer">{tr("本地模型离线运行 · 数据只存在本机")}</div>
    </aside>
  )
}
