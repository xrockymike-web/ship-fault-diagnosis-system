/** 知识管理 · 实体（自建图节点）。校验在后端：类型限本体 7 类、空名报错、同名给 warning。 */
import { useState } from 'react'
import type { UserEntity, UserKbSnapshot } from '../../../shared/types'
import { saveUserEntity, deleteUserEntity } from './api'
import type { UserKbController } from './useUserKb'
import Field from './components/Field'
import ConfirmDialog from '../components/ConfirmDialog'
import { tr } from '../lang/provider'

const EMPTY = { id: '', name: '', type: '', aliases: '', description: '' }

export default function EntityTab({ kb }: { kb: UserKbController }) {
  const snap = kb.snapshot as UserKbSnapshot
  const [form, setForm] = useState({ ...EMPTY })
  const [msg, setMsg] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null)
  const [pending, setPending] = useState<UserEntity | null>(null)
  const set = (k: keyof typeof EMPTY, v: string) => setForm((f) => ({ ...f, [k]: v }))

  const reset = () => { setForm({ ...EMPTY }); setMsg(null) }

  const submit = async () => {
    setMsg(null)
    try {
      const warnings = await kb.mutate(() =>
        saveUserEntity({
          id: form.id || undefined,
          name: form.name,
          type: form.type || snap.entityTypes[0],
          aliases: form.aliases.split(/[,，]/).map((x) => x.trim()).filter(Boolean),
          description: form.description || null,
        }),
      )
      setMsg(warnings.length ? { kind: 'warn', text: warnings.join('；') } : { kind: 'ok', text: form.id ? '已保存修改' : '已新增实体' })
      setForm({ ...EMPTY })
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message })   // 后端校验消息原样显示，不吞
    }
  }

  const remove = async () => {
    if (!pending) return
    const target = pending
    setPending(null)
    try {
      const warnings = await kb.mutate(() => deleteUserEntity(target.id))
      setMsg(warnings.length ? { kind: 'warn', text: warnings.join('；') } : { kind: 'ok', text: '已删除 ' + target.id })
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message })
    }
  }

  return (
    <div className="kb-cols">
      <div className="kb-form">
        <h3>{form.id ? '编辑实体 ' + form.id : '新增实体'}</h3>
        <Field label="名称" required>
          <input className="kb-input" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder={tr("例如：某型主机遥控板")} />
        </Field>
        <Field label="类型" required hint={tr("本体固定 7 类；不在其中的会被后端拒绝")}>
          <select className="kb-input" value={form.type} onChange={(e) => set('type', e.target.value)}>
            <option value="">{tr("（请选择）")}</option>
            {snap.entityTypes.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="别名" hint="逗号分隔；别名能帮检索认出它">
          <input className="kb-input" value={form.aliases} onChange={(e) => set('aliases', e.target.value)} placeholder={tr("遥控板, RCU")} />
        </Field>
        <Field label="说明">
          <textarea className="kb-input kb-textarea" rows={3} value={form.description} onChange={(e) => set('description', e.target.value)} />
        </Field>
        <div className="kb-actions">
          <button className="kbtn primary" onClick={submit}>{form.id ? '保存修改' : '新增实体'}</button>
          <button className="kbtn" onClick={reset}>{form.id ? '取消编辑' : '清空'}</button>
        </div>
        {msg ? <div className={'kb-msg ' + msg.kind}>{msg.text}</div> : null}
      </div>
      <div className="kb-list">
        <h3>{tr("自建实体")}<span className="kb-count">{snap.entities.length}</span></h3>
        {snap.entities.length === 0 ? <div className="kb-empty">{tr("还没有自建实体。左边填一条试试 —— 存完到「知识图谱」页就能看到（虚线环）。")}</div> : null}
        {snap.entities.map((e) => (
          <div className="kb-item" key={e.id}>
            <div className="kb-item-head">
              <span className="kb-badge user">{tr("自建")}</span>
              <span className="kb-item-name">{e.name}</span>
              {e.indexed ? (
                <span className="kb-chip ok" title={tr("已有向量，能走路B 语义召回")}>{tr("已索引")}</span>
              ) : (
                <span className="kb-chip warn" title={tr("没有向量 = 语义召回不到它（仍可被名字/别名匹配）；模型就绪后点「重建索引」")}>{tr("待索引")}</span>
              )}
              <span className="kb-item-meta">{e.type} · {e.id}</span>
            </div>
            {e.aliases.length ? <div className="kb-item-sub">别名：{e.aliases.join('、')}</div> : null}
            {e.description ? <div className="kb-item-sub">{e.description}</div> : null}
            <div className="kb-item-ops">
              <button className="kbtn tiny" onClick={() => { setForm({ id: e.id, name: e.name, type: e.type, aliases: e.aliases.join(', '), description: e.description ?? '' }); setMsg(null) }}>编辑</button>
              <button className="kbtn tiny danger" onClick={() => setPending(e)}>{tr("删除")}</button>
            </div>
          </div>
        ))}
      </div>
      <ConfirmDialog
        open={pending !== null}
        title={tr("删除自建实体")}
        body={<>「{pending?.name}」及其**关联的自建三元组**会一起删除，此操作不可撤销。</>}
        onConfirm={remove}
        onCancel={() => setPending(null)}
      />
    </div>
  )
}
