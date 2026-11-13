/**
 * 界面侧工具（目标 2.5 起**不再承载会话**）。
 *
 * 会话的读写已全部搬到后端：渲染进程 → MessagePort → `data/runtime/sessions.sqlite`
 * （D2-12：**不做旧数据迁移**，旧 localStorage 里的会话原样留在那里，不读不删）。
 * 本文件只剩：id/会话构造、侧边栏折叠偏好、时间格式化。
 */
import type { Session } from './types'
import { currentLocale, tr } from './lang/provider'

const SIDEBAR_KEY = 'ship-diagnosis.sidebar-collapsed.v1'

export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function createSession(): Session {
  const now = Date.now()
  return { id: newId(), title: tr('新会话'), createdAt: now, updatedAt: now, messages: [] }
}

/** 侧边栏折叠状态持久化（§15.2 缺口 9：刷新后保持） */
export function loadSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === '1'
  } catch {
    return false
  }
}

export function saveSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0')
  } catch (err) {
    console.warn('[storage] 侧边栏状态保存失败：', err)
  }
}

export function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function formatListTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  const pad = (n: number) => String(n).padStart(2, '0')
  if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return new Intl.DateTimeFormat(currentLocale() === 'en' ? 'en-US' : 'zh-CN', { month: 'short', day: 'numeric' }).format(d)
}

/** 耗时展示（§15.2 缺口 8）：首字 x.xs · 共 y.ys —— 与 1.5 真实流式同口径 */
export function formatElapsed(msg: { firstTokenAt?: number; finishedAt?: number; createdAt: number }): string | null {
  if (!msg.firstTokenAt && !msg.finishedAt) return null
  const parts: string[] = []
  if (msg.firstTokenAt) parts.push(tr('首字 {x}s', { x: ((msg.firstTokenAt - msg.createdAt) / 1000).toFixed(1) }))
  if (msg.finishedAt) parts.push(tr('共 {y}s', { y: ((msg.finishedAt - msg.createdAt) / 1000).toFixed(1) }))
  return parts.join(' · ')
}
