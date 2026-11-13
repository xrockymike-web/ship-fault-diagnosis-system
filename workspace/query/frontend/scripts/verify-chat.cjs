#!/usr/bin/env node
/**
 * 对话链路验证（目标 2.2 起；2.8 回归直接复跑）。
 *
 * 用法：node scripts/verify-chat.cjs <cdpPort> <out.json>
 *
 * 三件事：
 *   ① **Network 抓包** —— 渲染进程是否还有到模型端口的请求（判据：0 条）
 *   ② **流式对话** —— 点示例问题，测首字与总时长、拿到回答文本
 *   ③ **真中断** —— 生成中点「停止」，确认字数**不再增长**（不是前端装作停下）
 *
 * 只读：不改任何文件，除 out.json。
 */
const fs = require('node:fs')

const port = process.argv[2] || '9222'
const outJson = process.argv[3] || 'verify-chat.json'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error('没有 page target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws 连接失败')) })

  let seq = 0
  const pending = new Map()
  const requests = []
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
    if (m.method === 'Network.requestWillBeSent' && m.params && m.params.request) {
      requests.push({ url: m.params.request.url, method: m.params.request.method, type: m.params.type })
    }
  }
  const send = (method, params) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params: params || {} })) })
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.result && r.result.exceptionDetails) throw new Error('eval 异常：' + JSON.stringify(r.result.exceptionDetails).slice(0, 400))
    return r.result && r.result.result ? r.result.result.value : undefined
  }

  await send('Network.enable')

  // 页面内的发问助手：写输入框（React 受控组件要用原生 setter）+ 点发送
  const askHelper = `
    const ask = async (text) => {
      const ta = document.querySelector('textarea')
      if (!ta) return 'no-textarea'
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, text)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 150))
      const btn = document.querySelector('.btn-send')
      if (!btn) return 'no-send'
      btn.click()
      return 'ok'
    }
  `

  // ① 流式对话
  const streamRaw = await evaluate(`(async () => {
    ${askHelper}
    const sent = await ask('1+1 等于多少？')
    if (sent !== 'ok') return JSON.stringify({ error: '发送失败：' + sent })
    const t0 = performance.now()
    let first = null, text = ''
    for (let i = 0; i < 400; i++) {
      await new Promise(r => setTimeout(r, 50))
      const els = document.querySelectorAll('.msg-content')
      text = els.length ? els[els.length - 1].textContent : ''
      if (text && first === null) first = performance.now() - t0
      if (document.querySelector('.btn-rerun')) break
    }
    return JSON.stringify({ firstMs: first === null ? null : Math.round(first), totalMs: Math.round(performance.now() - t0), chars: text.length, text })
  })()`)
  const stream = JSON.parse(streamRaw)

  // ② 真中断：起一条，1.5 s 后点停止，再等 3 s 看字数是否还变
  const abortRaw = await evaluate(`(async () => {
    ${askHelper}
    const sent = await ask('热继电器不动作怎么排查？请分点说明，每点写清楚检查步骤。')
    if (sent !== 'ok') return JSON.stringify({ error: '发送失败：' + sent })
    await new Promise(r => setTimeout(r, 1500))
    const get = () => { const e = document.querySelectorAll('.msg-content'); return e.length ? e[e.length - 1].textContent.length : 0 }
    const before = get()
    const stop = document.querySelector('.btn-stop')
    if (!stop) return JSON.stringify({ error: '生成中没有停止按钮', before })
    stop.click()
    await new Promise(r => setTimeout(r, 100))
    const atStop = get()
    await new Promise(r => setTimeout(r, 3000))
    const after = get()
    return JSON.stringify({ before, atStop, after, stopped: atStop === after, growth: after - atStop })
  })()`)
  const abort = JSON.parse(abortRaw)

  await sleep(800)
  const toModel = requests.filter((q) => /127\.0\.0\.1:\d+/.test(q.url))
  const result = {
    at: new Date().toISOString(),
    stream,
    abort,
    network: { total: requests.length, toModelPort: toModel, all: requests },
  }
  fs.writeFileSync(outJson, JSON.stringify(result, null, 2))
  console.log('[verify] 流式：首字 ' + stream.firstMs + ' ms，总 ' + stream.totalMs + ' ms，' + stream.chars + ' 字')
  console.log('[verify] 回答：' + JSON.stringify(String(stream.text).slice(0, 80)))
  console.log('[verify] 中断：before=' + abort.before + ' atStop=' + abort.atStop + ' after=' + abort.after + ' → stopped=' + abort.stopped + '（增长 ' + abort.growth + '）')
  console.log('[verify] 网络：共 ' + requests.length + ' 条请求，其中到模型端口 ' + toModel.length + ' 条')
  for (const q of requests) console.log('         ' + q.method + ' ' + q.url)
  ws.close()
  await sleep(200)
}
main().catch((e) => { console.error('[verify] ✗ ' + e.message); process.exit(1) })
