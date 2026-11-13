import { useEffect, useRef } from 'react'
import type { Session } from '../types'
import { formatElapsed, formatTime } from '../storage'
import EvidencePanel, { TurnFigures } from './EvidencePanel'
import { tr } from '../lang/provider'

interface Props {
  session?: Session
  generating: boolean
  examples: string[]
  onAsk: (text: string) => void
  onRerun: () => void
  /** 三份图的全局收起态（顶栏「收起/展开所有图」） */
  figsCollapsed: boolean
}

/**
 * 回答正文：把 `[n]` 变成可点击的引用角标（点击滚到对应引用条目并闪一下）
 *
 * 🔴 2026-10-11（施工单《16-》§8）**显示层净化**（只影响显示，**归档里仍保存模型原文**）：
 *   ① 去掉模型抄回来的**书名 / 页码 / 块编号 / 「（证据：…）」**——出处由下方「引用来源」卡片负责，正文不需要；
 *   ② **只把真实存在的编号**渲染成角标，两级判定：
 *      · `n` 超出**证据包 citations 总数**（本轮编号空间，实测可达 43）→ 纯文本（模型编的/越界，消灭死链）；
 *      · `n` 在编号空间内但**大于面板卡片数**（卡片只列 3 条原文证据，其余是图谱/通路证据）→ 角标**不可点**（如实说明指向哪类证据）。
 */
function AnswerText({ text, msgId, citeMax, cardMax }: { text: string; msgId: string; citeMax: number; cardMax: number }) {
  const clean = text
    // CPU 小模型偶尔输出 [n:1] / 【】；显示层统一归一到 [1]
    .replace(/\[n\s*[:：]\s*(\d+)\]/g, '[$1]')
    .replace(/\[\s*\]/g, '')
    .replace(/【\s*】/g, '')
    .replace(/《[^》]{2,40}》/g, '')
    .replace(/[（(]\s*\d+\s*页扫描件\s*[）)]/g, '')
    .replace(/第\s*\d+\s*(?:[–~-]\s*\d+)?\s*页/g, '')
    // 🔴 v1.2：块编号成为资料里唯一可见的标识符 → 模型可能照抄它（规则 6 已禁，这里是显示层兜底）
    //    v1.3：兼容 3 字母新块号（TXT/PRT/TBL）+ 裸编号 + 「证据：…」来源头。
    .replace(/[（(]?\s*块\s*(?:号\s*)?(?:TXT|PRT|TBL|UT|UR|E|T|U)-\d{3,4}\s*[）)]?/g, '')
    .replace(/(^|[^\w\-])(?:TXT|PRT|TBL|UT|UR|E|T|U)-\d{3,4}(?![\w-])/g, '$1')
    .replace(/(^|[^\w\-])(?:ch|pa|tb)-\d{2}-\d{2}(?:-\d+)?/g, '$1')
    .replace(/[（(]?\s*证据[:：]\s*(?:导致|对应|包含|使用|适用|属于|需注意|可预防|前置|后续)?[:：]?\s*/g, '')
    .replace(/\s*[/·]\s*(?=[，。；、\n]|$)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
  const parts = clean.split(/(\[\d+\])/g)
  const jump = (n: number): void => {
    const el = document.getElementById('cite-' + msgId + '-' + (n - 1))
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('cite-flash')
    window.setTimeout(() => el.classList.remove('cite-flash'), 1200)
  }
  return (
    <div className="msg-content">
      {parts.map((p, i) => {
        const m = /^\[(\d+)\]$/.exec(p)
        if (!m) return <span key={i}>{p}</span>
        const n = Number(m[1])
        // 🔴 两级：编号空间外 → 纯文本；卡片范围外（图谱/通路证据）→ 不可点角标
        if (!(n >= 1 && n <= citeMax)) return <span key={i}>{p}</span>
        const linked = n <= cardMax
        return (
          <span
            key={i}
            className="cite-num"
            style={linked ? undefined : { opacity: 0.55, cursor: 'default' }}
            title={linked ? '查看引用 [' + n + ']' : '编号 [' + n + '] 指向图谱/通路证据（面板未列卡片）'}
            onClick={linked ? () => jump(n) : undefined}
          >
            [{n}]
          </span>
        )
      })}
    </div>
  )
}

export default function MessageList({ session, generating, examples, onAsk, onRerun, figsCollapsed }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const messages = session?.messages ?? []
  const last = messages[messages.length - 1]
  const lastLen = last?.content.length ?? 0

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length, session?.id, lastLen])

  if (!session || messages.length === 0) {
    return (
      <div className="message-list empty">
        <div className="empty-state">
          <img className="empty-icon" src={import.meta.env.BASE_URL + 'assets/anchor.svg'} alt="" />
          <div className="empty-title">{tr("开始新的提问")}</div>
          <div className="empty-desc">{tr("回答由本机的")}<strong>Qwen3-0.6B</strong>{tr("模型生成，全程离线、不联网、不上传。")}<br />{tr("每条回答都附带**可核对的引用**、**知识图谱子图**与**诊断路径**。")}</div>
          <div className="example-list">
            <div className="example-label">{tr("试试这些问题")}</div>
            {examples.map((q) => (
              <button key={q} className="example-item" onClick={() => onAsk(q)} disabled={generating}>
                {q}
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }

  const lastAssistantId = [...messages].reverse().find((m) => m.role === 'assistant')?.id
  const questionOf = (id: string): string => {
    const idx = messages.findIndex((x) => x.id === id)
    for (let i = idx - 1; i >= 0; i--) if (messages[i].role === 'user') return messages[i].content
    return ''
  }

  return (
    <div className="message-list">
      {messages.map((m) => {
        const streaming = m.status === 'streaming'
        const elapsed = formatElapsed(m)
        const isLastAssistant = m.id === lastAssistantId
        return (
          <div key={m.id} className={`msg-row ${m.role}`}>
            <div className="msg-avatar">{m.role === 'user' ? tr('我') : 'AI'}</div>
            <div className="msg-body">
              <div className="msg-meta">
                <span className="msg-role">{m.role === 'user' ? tr('你') : tr('诊断助手')}</span>
                <span className="msg-time">{formatTime(m.createdAt)}</span>
                {elapsed && <span className="msg-elapsed">{elapsed}</span>}
              </div>

              {m.status === 'error' ? (
                <div className="msg-error">
                  <span className="msg-error-icon">!</span>
                  <span className="msg-error-text">{m.error}</span>
                  <button className="btn-retry" onClick={onRerun} disabled={generating}>{tr("重试")}</button>
                </div>
              ) : m.role === 'assistant' ? (
                <>
                  {/* ①「证据与诊断」**在回答之前**（默认收起、只含文字） */}
                  {!streaming && <EvidencePanel bundle={m.evidence ?? null} question={questionOf(m.id)} msgId={m.id} answer={m.content} />}
                  <AnswerText
                    text={m.content}
                    msgId={m.id}
                    citeMax={m.evidence?.citations.length ?? 0}
                    cardMax={m.evidence?.text.evidences.length ?? 0}
                  />
                  {streaming && <span className="stream-cursor" />}
                  {/* ② 三份图**在回答之后**依次排开（默认展开；画不出来就不显示） */}
                  {!streaming && <TurnFigures bundle={m.evidence ?? null} collapsed={figsCollapsed} />}
                  {isLastAssistant && !streaming && (
                    <button className="btn-rerun" onClick={onRerun} disabled={generating}>{tr("↻ 重新生成")}</button>
                  )}
                </>
              ) : (
                <div className="msg-content">{m.content}</div>
              )}
            </div>
          </div>
        )
      })}
      <div ref={bottomRef} />
    </div>
  )
}
