/**
 * 就绪探测（施工单 §16.4）。
 * 轮询 llama-server 的 /health：间隔 500 ms，上限 30 s（目标 0 实测加载 1.64 s）。
 * 只做探测，不做任何路径解析 —— 端口由 process-manager 注入。
 */
export interface WaitReadyOptions {
  /** 总超时（ms），默认 30000 */
  timeoutMs?: number
  /** 轮询间隔（ms），默认 500 */
  intervalMs?: number
  /** 外部中止信号（服务被停掉时用） */
  shouldAbort?: () => boolean
}

export interface WaitReadyResult {
  ok: boolean
  /** 实际等待时长（ms） */
  elapsedMs: number
  /** 失败原因：'timeout' | 'aborted' | 'unreachable' */
  reason?: 'timeout' | 'aborted' | 'unreachable'
  lastError?: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function probeOnce(port: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/health', { method: 'GET' })
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status }
    const body = (await res.json()) as { status?: string }
    return { ok: body.status === 'ok', error: body.status ? 'status=' + body.status : undefined }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export async function waitForReady(port: number, options: WaitReadyOptions = {}): Promise<WaitReadyResult> {
  const timeoutMs = options.timeoutMs ?? 30000
  const intervalMs = options.intervalMs ?? 500
  const startedAt = Date.now()
  let lastError: string | undefined

  while (Date.now() - startedAt < timeoutMs) {
    if (options.shouldAbort?.()) {
      return { ok: false, elapsedMs: Date.now() - startedAt, reason: 'aborted', lastError }
    }
    const r = await probeOnce(port)
    if (r.ok) return { ok: true, elapsedMs: Date.now() - startedAt }
    lastError = r.error
    await sleep(intervalMs)
  }
  return { ok: false, elapsedMs: Date.now() - startedAt, reason: 'timeout', lastError }
}
