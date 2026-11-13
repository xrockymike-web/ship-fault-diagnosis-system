/**
 * 渲染进程 → 后端的**传输层**（唯一出口）。
 *
 * U1 · 模块化：从 sessions.ts **机械搬出**（行为一字不变 —— 同一套 seq / pending /
 * 超时 8000ms / 同样的错误文案）。领域函数（会话、知识库…）各自放在自己的文件里，
 * 只调这里，避免 sessions.ts 变成杂物间。
 *
 * 红线 R4：渲染进程不碰文件 —— 全部经 MessagePort 交给后端 utilityProcess。
 */
import type { BackendReplyEvt, BackendReq } from '../types'

let seq = 0
let listening = false
const pending = new Map<number, (evt: BackendReplyEvt) => void>()

/** 惰性注册（window.shipApp 由 preload 注入；这里不假设注入时机） */
function ensureListening(): Window['shipApp'] | undefined {
  const api = window.shipApp
  if (!api) return undefined
  if (!listening) {
    api.onBackendMessage((evt) => {
      if (evt.kind !== 'reply') return
      const resolve = pending.get(evt.id)
      if (resolve) {
        pending.delete(evt.id)
        resolve(evt)
      }
    })
    listening = true
  }
  return api
}

/** 发一条请求并把定长响应配成 Promise（超时**明确报错**，不静默） */
export function send(kind: BackendReq['kind'], payload: Record<string, unknown>, timeoutMs = 8000): Promise<unknown> {
  const api = ensureListening()
  if (!api) return Promise.reject(new Error('window.shipApp 未注入（preload 可能不是 CJS 形态）'))
  const id = ++seq
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(id)
      reject(new Error('后端无响应：' + kind + '（' + timeoutMs + ' ms）'))
    }, timeoutMs)
    pending.set(id, (evt) => {
      window.clearTimeout(timer)
      if (evt.error) reject(new Error(evt.error))
      else resolve(evt.data)
    })
    api.sendToBackend({ id, kind, ...payload } as unknown as BackendReq)
  })
}
