/**
 * 会话域客户端（目标 2.5）：把 §4.1 的 `session.*` 请求包成 Promise。
 *
 * U1 · 模块化：**传输层搬到 `./backend/client`**；本文件只留"会话域"。
 * 🔴 导出签名与改造前**一字不变**（listSessions / saveSession / deleteSession /
 *    clearSessions / graphOverview）→ App.tsx 与各组件**不需要改**。
 *
 * 数据全程经 MessagePort → 后端 utilityProcess → `data/runtime/sessions.sqlite`；
 * **渲染进程不碰文件**（红线 R4），也不再使用 localStorage 存会话（D2-12：不做旧数据迁移）。
 */
import type { Session } from './types'
import type { GraphOverview } from '../../shared/types'
import { send } from './backend/client'
import { currentLocale } from './lang/provider'

export function listSessions(): Promise<Session[]> {
  return send('session.list', { locale: currentLocale() }) as Promise<Session[]>
}

export function saveSession(session: Session): Promise<unknown> {
  return send('session.save', { session })
}

export function deleteSession(sessionId: string): Promise<unknown> {
  return send('session.delete', { sessionId })
}

export function clearSessions(): Promise<unknown> {
  return send('session.clear', {})
}

/**
 * 目标 5 · ①：全貌页数据（决策 D27）。
 * 一次性拉全量（1463 实体 / 1116 边），**前端内存缓存**；超时给宽一点（首次要读库）。
 */
export function graphOverview(): Promise<GraphOverview> {
  return send('graph.overview', { locale: currentLocale() }, 20000) as Promise<GraphOverview>
}
