/**
 * 应用内确认浮层 —— 删除会话用（替代原生 window.confirm）。
 *
 * 为什么不用 window.confirm：那是 **Chromium 原生框**（系统灰、英文按钮、同步阻塞渲染进程），
 * 与本客户端的浅色中文主题是两套语言。本组件只复用 :root 的 design tokens
 * （--panel / --border / --radius / --danger）与既有动效节奏，不引入任何新依赖。
 *
 * 交互：Esc = 取消；点遮罩 = 取消；打开时焦点落在「取消」（危险操作默认不给"删"）；
 *       Tab 在卡片内循环（不逃到背景）；role="dialog" + aria-modal + aria-labelledby。
 */
import { useEffect, useRef, type ReactNode } from 'react'

interface Props {
  open: boolean
  title: string
  body: ReactNode
  /** 危险动作按钮文案（默认「删除」） */
  confirmText?: string
  cancelText?: string
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmDialog({
  open,
  title,
  body,
  confirmText = '删除',
  cancelText = '取消',
  onConfirm,
  onCancel,
}: Props) {
  const cardRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  // 打开时焦点落在「取消」：这是危险操作，默认焦点不给"删"
  useEffect(() => {
    if (open) cancelRef.current?.focus()
  }, [open])

  // Esc 取消 + Tab 锁在卡片内（只有两个按钮，循环即可）
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
        return
      }
      if (e.key !== 'Tab') return
      const card = cardRef.current
      if (!card) return
      const btns = Array.from(card.querySelectorAll<HTMLButtonElement>('button'))
      if (btns.length === 0) return
      const first = btns[0]
      const last = btns[btns.length - 1]
      const active = document.activeElement
      const inside = active !== null && card.contains(active)
      if (e.shiftKey && (!inside || active === first)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (!inside || active === last)) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onCancel])

  if (!open) return null

  return (
    <div
      className="confirm-overlay"
      // 用 mousedown 判「点在遮罩本身」：拖动选中文字后松手落在遮罩上不误关
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        className="confirm-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        ref={cardRef}
      >
        <div className="confirm-title" id="confirm-title">
          {title}
        </div>
        <div className="confirm-body">{body}</div>
        <div className="confirm-actions">
          <button className="confirm-btn" ref={cancelRef} onClick={onCancel}>
            {cancelText}
          </button>
          <button className="confirm-btn danger" onClick={onConfirm}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
