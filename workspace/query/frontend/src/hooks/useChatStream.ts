/**
 * 对话流（目标 2.2 起）—— **不再直连 llama-server**：请求经 MessagePort 交给后端进程，
 * 后端负责 payload（提示词 + 历史裁剪）与真正的 HTTP，本文件只做三件事：
 *   ① 按协议发 `chat`；② 收 `chat.delta` 拼字；③ 用户点停止时发 `abort`。
 *
 * `ChatStream` 接口**一行没变**（1.3 抽出来就是为了这一刻）：
 * 界面组件仍然只认识 `start({ messages, onDelta, onDone, onError })`。
 *
 * 超时口径（🆕 v0.3.2 起**按档**）：GPU 档与目标 1.5 / v0.3.1 完全一致（15 s / 120 s）→ 回归可比；
 *   CPU 档 45 s / 240 s（负责人 2026-10-12 定值）。值由主进程经 IPC 下发，见 `src/dial.ts`。
 */
import type { ChatMessage, ChatStream } from '../types'
import { currentDial } from '../dial'
import { currentLocale } from '../lang/provider'

export interface ChatStreamOptions {
  sessionId: string
  assistantMessageId: string
}

/**
 * 首字超时 / 总时长上限 —— 🆕 v0.3.2 起**按档取值**：
 *   GPU 15 s / 120 s（与 v0.3.1 逐字等价）｜ CPU 45 s / 240 s（负责人 2026-10-12 定值）。
 *   由主进程经 IPC 下发（缓存在 `src/dial.ts`）；**取不到就退回 GPU 档原值**，不静默变 0。
 */
const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 15000
const DEFAULT_TOTAL_TIMEOUT_MS = 120000

let reqSeq = 0
function nextReqId(): number {
  reqSeq += 1
  return reqSeq
}

export function createChatStream(opts: ChatStreamOptions): ChatStream {
  return {
    start({ messages, userMessageId, onDelta, onDone, onError }) {
      const api = window.shipApp
      const current: ChatMessage | undefined = messages[messages.length - 1]
      if (!api) {
        // 这条本身就是判据：preload 若不是 CJS，shipApp 根本不存在（1.2 证据 02）
        onError({ kind: 'no-bridge', message: 'window.shipApp 未注入：preload 可能不是 CJS 形态（见阶段1.2 证据 02）' })
        return { abort() { /* 没起来 */ } }
      }

      const id = nextReqId()
      let finished = false
      let firstTokenTimer: number | undefined
      let totalTimer: number | undefined

      const cleanup = (): void => {
        window.clearTimeout(firstTokenTimer)
        window.clearTimeout(totalTimer)
      }
      const off = api.onBackendMessage((evt) => {
        if (!evt || evt.id !== id) return
        if (evt.kind === 'chat.delta') {
          if (firstTokenTimer !== undefined) {
            window.clearTimeout(firstTokenTimer)
            firstTokenTimer = undefined
          }
          onDelta(evt.text)
          return
        }
        if (evt.kind === 'chat.done') done(evt.evidence)
        else if (evt.kind === 'chat.error') fail(evt.error.kind, evt.error.message)
      })
      const finish = (): void => {
        finished = true
        cleanup()
        off()
      }
      const fail = (kind: string, message: string): void => {
        if (finished) return
        finish()
        onError({ kind, message })
      }
      const done = (evidence?: unknown): void => {
        if (finished) return
        finish()
        onDone((evidence ?? null) as never)
      }

      // 🆕 v0.3.2：按档取值（CPU 45 s / 240 s；GPU 15 s / 120 s）
      const d = currentDial()
      const firstMs = d.firstTokenMs > 0 ? d.firstTokenMs : DEFAULT_FIRST_TOKEN_TIMEOUT_MS
      const totalMs = d.totalMs > 0 ? d.totalMs : DEFAULT_TOTAL_TIMEOUT_MS
      firstTokenTimer = window.setTimeout(
        () => fail('timeout-first', '等待首个字节超时（' + firstMs / 1000 + ' 秒，' + d.dial + ' 档）。模型可能仍在加载，或端口被占用。'),
        firstMs,
      )
      totalTimer = window.setTimeout(
        () => fail('timeout-total', '生成总时长超过 ' + totalMs / 1000 + ' 秒，已中断。'),
        totalMs,
      )

      api.sendToBackend({
        id,
        kind: 'chat',
        locale: currentLocale(),
        sessionId: opts.sessionId,
        assistantMessageId: opts.assistantMessageId,
        userMessage: {
          id: userMessageId ?? 'um-' + id,
          content: current?.content ?? '',
          createdAt: Date.now(),
        },
      })

      return {
        abort() {
          if (finished) return
          finish()
          // AbortController 不能跨进程传 ⇒ 取消是一条**独立的 abort 消息**，用 targetId 指回原请求
          api.sendToBackend({ id: nextReqId(), kind: 'abort', targetId: id })
        },
      }
    },
  }
}
