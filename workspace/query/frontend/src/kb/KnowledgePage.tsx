/**
 * 知识管理页（U2）—— 侧边栏第三项，页内三个子标签：实体 / 关系 / 文本。
 *
 * 定位：**只管用户自建知识**（存 `<dataDir>/user_data/`），教材知识库一个字不动。
 * 纪律：读取失败 / 保存失败**都要显示出来**（后端校验消息原样呈现，不吞）。
 */
import { useState } from 'react'
import { reindexUserKb } from './api'
import { useUserKb } from './useUserKb'
import EntityTab from './EntityTab'
import TripleTab from './TripleTab'
import TextTab from './TextTab'
import { tr } from '../lang/provider'

type Tab = 'entity' | 'triple' | 'text'
const TABS: { k: Tab; label: string }[] = [
  { k: 'entity', label: '实体' },
  { k: 'triple', label: '关系' },
  { k: 'text', label: '文本' },
]

export default function KnowledgePage() {
  const kb = useUserKb()
  const [tab, setTab] = useState<Tab>('entity')
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [reindexing, setReindexing] = useState(false)
  /** U3：「重建索引」——嵌入模型没就绪时后端会明确回错（不静默） */
  const doReindex = () => {
    setReindexing(true)
    setMsg(null)
    reindexUserKb()
      .then((r) => setMsg({ kind: 'ok', text: '已补 ' + r.embedded + ' 条向量；仍待索引 ' + r.pending + ' 条' }))
      .catch((e: Error) => setMsg({ kind: 'err', text: '重建索引失败：' + e.message }))
      .finally(() => {
        setReindexing(false)
        kb.reload()
      })
  }

  if (!kb.snapshot) {
    return (
      <div className="kb-page">
        <div className="kb-toolbar"><span className="kb-title">{tr("用户知识库")}</span></div>
        {kb.error ? (
          <div className="kb-body">
            <div className="kb-msg err">读取失败：{kb.error}</div>
            <div className="kb-actions"><button className="kbtn" onClick={kb.reload}>{tr("重试")}</button></div>
          </div>
        ) : (
          <div className="kb-body"><div className="kb-empty">{tr("正在读取用户知识库…")}</div></div>
        )}
      </div>
    )
  }

  const s = kb.snapshot
  return (
    <div className="kb-page">
      <div className="kb-toolbar">
        <span className="kb-title">{tr("用户知识库")}</span>
        <span className="kb-hint">{tr("只存在 data/user_data/ —— 内置知识库一个字不动")}</span>
        {s.pendingIndex ? (
          <span className="kb-chip warn" title={tr("没有向量 = 检索暂时查不到；嵌入模型就绪后点右边「重建索引」")}>
            {s.pendingIndex} 条待索引
          </span>
        ) : null}
        <button
          className="kbtn tiny"
          title={tr("给还没有向量的文本/实体补向量（需要嵌入模型已就绪）")}
          onClick={() => {
            reindexing ? undefined : doReindex()
          }}
        >
          {reindexing ? '正在建索引…' : '重建索引'}
        </button>
        <span className="kb-stat">自建 {s.entities.length} 实体 · {s.triples.length} 关系 · {s.texts.length} 文本 · rev {s.revision}</span>
      </div>
      {msg ? <div className={'kb-msg ' + msg.kind}>{msg.text}</div> : null}
      <div className="kb-tabs">
        {TABS.map((t) => (
          <button key={t.k} className={'kb-tab' + (tab === t.k ? ' on' : '')} onClick={() => setTab(t.k)}>{t.label}</button>
        ))}
      </div>
      <div className="kb-body">
        {tab === 'entity' ? <EntityTab kb={kb} /> : tab === 'triple' ? <TripleTab kb={kb} /> : <TextTab kb={kb} />}
      </div>
    </div>
  )
}
