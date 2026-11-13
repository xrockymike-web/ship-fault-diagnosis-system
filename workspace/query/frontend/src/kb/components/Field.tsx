/** 表单一行的通用外壳（label + 控件 + 提示）；只做排版，不做校验（校验在后端） */
import type { ReactNode } from 'react'

interface Props {
  label: string
  required?: boolean
  hint?: ReactNode
  children: ReactNode
}

export default function Field({ label, required, hint, children }: Props) {
  return (
    <label className="kb-field">
      <span className="kb-field-label">
        {label}
        {required ? <b className="kb-req">*</b> : null}
      </span>
      <span className="kb-field-ctl">{children}</span>
      {hint ? <span className="kb-field-hint">{hint}</span> : null}
    </label>
  )
}
