/**
 * 用户知识库域客户端（U1 只建骨架；界面在 U2/U3 接）。
 *
 * 分层：组件 → `kb/api`（域封装）→ `../backend/client`（传输层）→ MessagePort → qa-core。
 * 本文件**不做 IO、不做校验** —— 校验在后端 `qa-core/user-kb.ts`（越界一律明确报错）。
 */
import type {
  UserKbDeleteResult,
  UserKbSaveResult,
  UserKbSnapshot,
} from '../../../shared/types'
import { send } from '../backend/client'

/** 与后端 `qa-core/user-kb.ts` 的输入形状保持一致（不带 id = 新建，带 id = 编辑） */
export interface UserTextInput { id?: string; title?: string; text: string; sourceNote?: string | null }
export interface UserEntityInput { id?: string; name: string; type: string; aliases?: string[]; description?: string | null }
export interface UserTripleInput { id?: string; subjectId: string; predicate: string; objectId: string; note?: string | null }

/** 一次拉全量（自建量级小；与全貌页同策略）。首次要读库 → 超时放宽。 */
export function listUserKb(): Promise<UserKbSnapshot> {
  return send('kb.list', {}, 20000) as Promise<UserKbSnapshot>
}

export function saveUserText(input: UserTextInput): Promise<UserKbSaveResult> {
  return send('kb.text.save', { input }) as Promise<UserKbSaveResult>
}

export function deleteUserText(targetId: string): Promise<UserKbDeleteResult> {
  return send('kb.text.delete', { targetId }) as Promise<UserKbDeleteResult>
}

export function saveUserEntity(input: UserEntityInput): Promise<UserKbSaveResult> {
  return send('kb.entity.save', { input }) as Promise<UserKbSaveResult>
}

export function deleteUserEntity(targetId: string): Promise<UserKbDeleteResult> {
  return send('kb.entity.delete', { targetId }) as Promise<UserKbDeleteResult>
}

export function saveUserTriple(input: UserTripleInput): Promise<UserKbSaveResult> {
  return send('kb.triple.save', { input }) as Promise<UserKbSaveResult>
}

export function deleteUserTriple(targetId: string): Promise<UserKbDeleteResult> {
  return send('kb.triple.delete', { targetId }) as Promise<UserKbDeleteResult>
}

/** 🆕 U3：重建索引（把还没有向量的文本/实体补上）。可能较慢（要调嵌入服务）→ 超时放宽。 */
export function reindexUserKb(): Promise<{ revision: number; embedded: number; pending: number }> {
  return send('kb.reindex', {}, 120000) as Promise<{ revision: number; embedded: number; pending: number }>
}
