import { useRef, useState } from 'react'
import { tr } from '../lang/provider'
import type { Msg } from '../lang/messages';

interface Props {
  onSend: (text: string) => void
  onStop: () => void
  generating: boolean
  disabled?: boolean
}

export default function Composer({ onSend, onStop, generating, disabled }: Props) {
  const [text, setText] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)

  const submit = () => {
    const trimmed = text.trim()
    if (!trimmed || disabled || generating) return
    onSend(trimmed)
    setText('')
    if (taRef.current) taRef.current.style.height = 'auto'
  }

  return (
    <div className="composer">
      <div className="composer-box">
        <textarea
          ref={taRef}
          className="composer-input"
          placeholder={tr(
            generating
              ? ('正在生成…（可点右侧「停止」中断）' as Msg)
              : ('描述设备现象或故障，例如：电磁制动器吸合后马上又释放是哪些原因引起的？' as Msg),
          )}
          rows={1}
          value={text}
          disabled={generating}
          onChange={(e) => {
            setText(e.target.value)
            e.target.style.height = 'auto'
            e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px'
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        {generating ? (
          <button className="btn-send btn-stop" onClick={onStop} title={tr("停止生成")}>{tr("停止")}</button>
        ) : (
          <button
            className="btn-send"
            onClick={submit}
            disabled={disabled || !text.trim()}
            title={tr("发送（Enter）")}
          >{tr("发送")}</button>
        )}
      </div>
      <div className="composer-hint">{tr("Enter 发送 · Shift+Enter 换行 · 回答由本机模型生成，速度取决于电脑性能")}</div>
    </div>
  )
}
