/**
 * 回答生成（职责见《技术路线总纲》§7.1.1：llama.cpp 三进程调用、流式转发、引用解析）。
 *
 * 目标 2.5（步骤 2.5.4）先落 **Embedding / Reranker 的薄封装**，供目标 3 建库与目标 4 检索调用：
 *   · embed(texts, { port })        → number[][]（1024 维，模型默认）
 *   · rerank(query, docs, { port }) → { index, score }[]
 *
 * 三条纪律：
 *   1. **只做调用与解析**，不含任何排序 / 融合 / 筛选逻辑 —— 重排逻辑属 `text-retrieval/`（目标 4，D25-20）；
 *   2. 端口与超时由**调用方注入**：本模块不解析路径、不读配置（红线 R3：路径解析只在 launcher/bootstrap）；
 *   3. 出错**指名道姓**（HTTP 码 / 端口 / 服务角色），绝不静默降级。
 */

export interface ServiceEndpoint {
  port: number
  host?: string
}

export interface EmbedOptions extends ServiceEndpoint {
  signal?: AbortSignal
  timeoutMs?: number
}

export interface RerankOptions extends EmbedOptions {
  /** 只取前 N 条（不传 = 全要） */
  topN?: number
}

export interface RerankResult {
  index: number
  score: number
}

const DEFAULT_TIMEOUT_MS = 30000

function baseUrl(e: ServiceEndpoint): string {
  return 'http://' + (e.host ?? '127.0.0.1') + ':' + e.port
}

/** 统一 POST：超时与外部取消合成为一个 controller；非 2xx 一律抛出并带上 URL 与响应片段 */
async function postJson(url: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('请求超时（' + timeoutMs + ' ms）')), timeoutMs)
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error('模型服务返回 HTTP ' + res.status + '：' + url + (text ? '\n  ' + text.slice(0, 300) : ''))
    }
    return (await res.json()) as unknown
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 批量向量化（POST /v1/embeddings）。返回顺序与入参一致（按响应里的 index 排序）。
 * 维度由服务端决定（本项目 = 1024，模型默认）；调用方负责校验。
 */
export async function embed(texts: string[], options: EmbedOptions): Promise<number[][]> {
  if (!Array.isArray(texts) || texts.length === 0) throw new Error('embed：texts 不能为空')
  const url = baseUrl(options) + '/v1/embeddings'
  const json = (await postJson(url, { input: texts }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.signal)) as {
    data?: Array<{ index?: number; embedding?: number[] }>
  }
  const rows = json.data
  if (!Array.isArray(rows) || rows.length !== texts.length) {
    throw new Error('Embedding 服务返回形状不对（期望 data 长度 ' + texts.length + '）：' + url)
  }
  const sorted = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  return sorted.map((r, i) => {
    if (!Array.isArray(r.embedding) || r.embedding.length === 0) {
      throw new Error('Embedding 服务第 ' + i + ' 条没有 embedding：' + url)
    }
    return r.embedding
  })
}

/**
 * 重排打分（POST /v1/rerank）。**只返回原始分数**，排序由调用方决定（目标 4 的 text-retrieval）。
 */
export async function rerank(query: string, documents: string[], options: RerankOptions): Promise<RerankResult[]> {
  if (!query) throw new Error('rerank：query 不能为空')
  if (!Array.isArray(documents) || documents.length === 0) throw new Error('rerank：documents 不能为空')
  const url = baseUrl(options) + '/v1/rerank'
  const body: Record<string, unknown> = { query, documents }
  if (typeof options.topN === 'number') body.top_n = options.topN
  const json = (await postJson(url, body, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.signal)) as {
    results?: Array<{ index?: number; relevance_score?: number }>
  }
  const rows = json.results
  if (!Array.isArray(rows)) {
    throw new Error('Rerank 服务返回形状不对（没有 results）：' + url)
  }
  return rows.map((r) => ({ index: Number(r.index ?? -1), score: Number(r.relevance_score ?? NaN) }))
}
