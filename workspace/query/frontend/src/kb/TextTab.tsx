/**
 * 知识管理 · 文本（用户录入原文）。
 *
 * U3 起：保存时**调本地 embed() 建向量**；嵌入模型没就绪就标「待索引」（**不静默**），
 *         模型就绪后在页面上方点「重建索引」即可补上。
 * U4 起：建好向量的文本会**逻辑并入检索**（出现在回答旁的证据里，引用标「用户录入」）。
 */
import { useState } from 'react'
import type { UserKbSnapshot, UserText } from '../../../shared/types'
import { saveUserText, deleteUserText } from './api'
import type { UserKbController } from './useUserKb'
import Field from './components/Field'
import ConfirmDialog from '../components/ConfirmDialog'
import { tr } from '../lang/provider'

const EMPTY = { id: '', title: '', text: '', sourceNote: '' }

export default function TextTab({ kb }: { kb: UserKbController }) {
  const snap = kb.snapshot as UserKbSnapshot
  const [form, setForm] = useState({ ...EMPTY })
  const [msg, setMsg] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null)
  const [pending, setPending] = useState<UserText | null>(null)
  const set = (k: keyof typeof EMPTY, v: string) => setForm((f) => ({ ...f, [k]: v }))

  const reset = () => { setForm({ ...EMPTY }); setMsg(null) }

  const submit = async () => {
    setMsg(null)
    try {
      await kb.mutate(() => saveUserText({ id: form.id || undefined, title: form.title, text: form.text, sourceNote: form.sourceNote || null }))
      setMsg({ kind: 'ok', text: form.id ? '已保存修改' : '已新增文本' })
      setForm({ ...EMPTY })
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message })
    }
  }

  const remove = async () => {
    if (!pending) return
    const target = pending
    setPending(null)
    try {
      await kb.mutate(() => deleteUserText(target.id))
      setMsg({ kind: 'ok', text: '已删除 ' + target.id })
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message })
    }
  }

  return (
    <div className="kb-cols">
      <div className="kb-form">
        <h3>{form.id ? '编辑文本 ' + form.id : '新增文本'}</h3>
        <Field label="标题"><input className="kb-input" value={form.title} onChange={(e) => set('title', e.target.value)} placeholder={tr("例如：某型遥控板接线说明")} /></Field>
        <Field label="正文" required>
          <textarea className="kb-input kb-textarea" rows={10} value={form.text} onChange={(e) => set('text', e.target.value)} placeholder={tr("直接粘贴原文或你的检修记录…")} />
        </Field>
        <Field label="来源备注" hint="例如：2026-10 某船厂检修记录">
          <input className="kb-input" value={form.sourceNote} onChange={(e) => set('sourceNote', e.target.value)} />
        </Field>
        <div className="kb-actions">
          <button className="kbtn primary" onClick={submit}>{form.id ? '保存修改' : '新增文本'}</button>
          <button className="kbtn" onClick={reset}>{form.id ? '取消编辑' : '清空'}</button>
        </div>
        {msg ? <div className={'kb-msg ' + msg.kind}>{msg.text}</div> : null}
      </div>
      <div className="kb-list">
        <h3>{tr("自建文本")}<span className="kb-count">{snap.texts.length}</span></h3>
        {snap.texts.length === 0 ? <div className="kb-empty">{tr("还没有自建文本。")}</div> : null}
        {snap.texts.map((t) => (
          <div className="kb-item" key={t.id}>
            <div className="kb-item-head">
              <span className="kb-badge user">{tr("自建")}</span>
              <span className="kb-item-name">{t.title || '（无标题）'}</span>
              <span className="kb-item-meta">{t.id}</span>
              {t.indexed ? (
                <span className="kb-chip ok" title={tr("已有向量，能被检索到")}>{tr("已索引")}</span>
              ) : (
                <span className="kb-chip warn" title={tr("没有向量 = 检索暂时查不到；模型就绪后点页面上方「重建索引」")}>{tr("待索引")}</span>
              )}
            </div>
            <div className="kb-item-sub">{t.text.length > 120 ? t.text.slice(0, 120) + '…' : t.text}</div>
            {t.sourceNote ? <div className="kb-item-sub">来源：{t.sourceNote}</div> : null}
            <div className="kb-item-ops">
              <button className="kbtn tiny" onClick={() => { setForm({ id: t.id, title: t.title, text: t.text, sourceNote: t.sourceNote ?? '' }); setMsg(null) }}>编辑</button>
              <button className="kbtn tiny danger" onClick={() => setPending(t)}>{tr("删除")}</button>
            </div>
          </div>
        ))}
      </div>
      <ConfirmDialog
        open={pending !== null}
        title={tr("删除自建文本")}
        body={<>「{pending?.title || pending?.id}」将从本机永久删除，此操作不可撤销。</>}
        onConfirm={remove}
        onCancel={() => setPending(null)}
      />
    </div>
  )
}
