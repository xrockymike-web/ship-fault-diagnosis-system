/**
 * 🆕 v0.3.2：档位在**渲染进程侧**的只读缓存。
 *
 * 为什么需要这个文件：
 *   `useChatStream.start()` 是**同步**的（返回 `{ abort }`），不能在里面 `await` IPC；
 *   所以档位在 App 挂载时拉一次、缓存在这里，超时值同步取用。
 *
 * 🔴 三条纪律：
 *   1. **只读** —— 这里没有任何切换档位的入口（负责人 2026-10-12 定：前端不给用户切档）。
 *   2. **取不到就退回 GPU 档原值**（15 s / 120 s，即 v0.3.1 口径），绝不静默变成 0。
 *   3. 失败**不抛错、不阻塞对话**，只在 console 记一条。
 */
import type { DialInfo } from './types'

/** 拿不到主进程档位时的兜底 = v0.3.1 原值（GPU 档） */
const FALLBACK: DialInfo = {
  dial: 'cuda',
  snapshot: null,
  firstTokenMs: 15000,
  totalMs: 120000,
  notice: { cpu: 'CPU 模式，回答较慢', waiting: '模型思考 / 检索材料中…' },
}

let cached: DialInfo = FALLBACK

/** 同步取当前档位（供 useChatStream 用） */
export function currentDial(): DialInfo {
  return cached
}

/** App 挂载时调一次；失败保持兜底值 */
export async function loadDial(): Promise<DialInfo> {
  try {
    const api = window.shipApp
    if (!api || typeof api.getDial !== 'function') return cached
    const info = await api.getDial()
    if (info && typeof info.firstTokenMs === 'number' && info.firstTokenMs > 0 && typeof info.totalMs === 'number' && info.totalMs > 0) {
      cached = info
    }
    return cached
  } catch (err) {
    console.warn('[dial] 取档位失败，按 GPU 档默认值走：', (err as Error).message)
    return cached
  }
}
