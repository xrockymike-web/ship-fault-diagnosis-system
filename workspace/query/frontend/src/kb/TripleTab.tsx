/** 知识管理 · 关系（自建三元组）。两端必须存在（教材 ∪ 自建），否则后端明确报错。 */
import { useState } from 'react'
import type { UserKbSnapshot, UserTriple } from '../../../shared/types'
import { saveUserTriple, deleteUserTriple } from './api'
import type { UserKbController } from './useUserKb'
import Field from './components/Field'
import EndpointPicker from './components/EndpointPicker'
import ConfirmDialog from '../components/ConfirmDialog'
import { tr } from '../lang/provider'

const EMPTY = { id: '', subjectId: '', predicate: '', objectId: '', note: '' }
const label = (kb: UserKbSnapshot, id: string): string => {
  const mine = kb.entities.find((e) => e.id === id)
  if (mine) return mine.name
  return id
}

export default function TripleTab({ kb }: { kb: UserKbController }) {
  const snap = kb.snapshot as UserKbSnapshot
  const [form, setForm] = useState({ ...EMPTY })
  const [msg, setMsg] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null)
  const [pending, setPending] = useState<UserTriple | null>(null)
  const set = (k: keyof typeof EMPTY, v: string) => setForm((f) => ({ ...f, [k]: v }))

  const reset = () => { setForm({ ...EMPTY }); setMsg(null) }

  const submit = async () => {
    setMsg(null)
    try {
      const warnings = await kb.mutate(() =>
        saveUserTriple({
          id: form.id || undefined,
          subjectId: form.subjectId,
          predicate: form.predicate || snap.relationTypes[0],
          objectId: form.objectId,
          note: form.note || null,
        }),
      )
      setMsg(warnings.length ? { kind: 'warn', text: warnings.join('；') } : { kind: 'ok', text: form.id ? '已保存修改' : '已新增三元组' })
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
      await kb.mutate(() => deleteUserTriple(target.id))
      setMsg({ kind: 'ok', text: '已删除 ' + target.id })
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message })
    }
  }

  return (
    <div className="kb-cols">
      <div className="kb-form">
        <h3>{form.id ? '编辑三元组 ' + form.id : '新增三元组'}</h3>
        <Field label="头实体" required hint="输入名称筛选后点选；内置与自建都能选">
          <EndpointPicker kb={snap} value={form.subjectId} onChange={(id) => set('subjectId', id)} />
        </Field>
        <Field label="关系" required hint="本体固定 11 类">
          <select className="kb-input" value={form.predicate} onChange={(e) => set('predicate', e.target.value)}>
            <option value="">{tr("（请选择）")}</option>
            {snap.relationTypes.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </Field>
        <Field label="尾实体" required>
          <EndpointPicker kb={snap} value={form.objectId} onChange={(id) => set('objectId', id)} />
        </Field>
        <Field label="备注">
          <input className="kb-input" value={form.note} onChange={(e) => set('note', e.target.value)} />
        </Field>
        <div className="kb-actions">
          <button className="kbtn primary" onClick={submit}>{form.id ? '保存修改' : '新增三元组'}</button>
          <button className="kbtn" onClick={reset}>{form.id ? '取消编辑' : '清空'}</button>
        </div>
        {msg ? <div className={'kb-msg ' + msg.kind}>{msg.text}</div> : null}
      </div>
      <div className="kb-list">
        <h3>{tr("自建关系")}<span className="kb-count">{snap.triples.length}</span></h3>
        {snap.triples.length === 0 ? <div className="kb-empty">{tr("还没有自建关系。左边选两个实体（可以一个是内置知识库实体）连一条试试。")}</div> : null}
        {snap.triples.map((t) => (
          <div className="kb-item" key={t.id}>
            <div className="kb-item-head">
              <span className="kb-badge user">{tr("自建")}</span>
              <span className="kb-item-name">{label(snap, t.subjectId)} <b className="kb-rel">--{t.predicate}--&gt;</b> {label(snap, t.objectId)}</span>
              <span className="kb-item-meta">{t.id}</span>
            </div>
            <div className="kb-item-sub">{t.subjectId} → {t.objectId}{t.note ? ' · ' + t.note : ''}</div>
            <div className="kb-item-ops">
              <button className="kbtn tiny" onClick={() => { setForm({ id: t.id, subjectId: t.subjectId, predicate: t.predicate, objectId: t.objectId, note: t.note ?? '' }); setMsg(null) }}>编辑</button>
              <button className="kbtn tiny danger" onClick={() => setPending(t)}>{tr("删除")}</button>
            </div>
          </div>
        ))}
      </div>
      <ConfirmDialog
        open={pending !== null}
        title={tr("删除自建三元组")}
        body={<>「{pending?.id}」将从本机永久删除，此操作不可撤销。</>}
        onConfirm={remove}
        onCancel={() => setPending(null)}
      />
    </div>
  )
}
