#!/usr/bin/env node
/**
 * CDP 探针（目标 2 起复用；阶段 1 的手法固化成脚本）。
 *
 * 用法：
 *   node scripts/cdp-probe.cjs <port> [--png <out.png>] [--eval "<js>"] [--close] [--network <out.json>]
 *
 * 做的事（按参数）：
 *   · 连 http://127.0.0.1:<port>/json/list，取第一个 page target
 *   · --eval   在页面里执行表达式，打印结果（returnByValue）
 *   · --png    Page.captureScreenshot 存 PNG
 *   · --network  Network.enable 后记录请求 URL（用于"渲染进程不再直连模型服务"的取证）
 *   · --close  window.close()（等效用户关窗，走 app.quit 的清理路径）
 *
 * 只读：除 --png / --network 写的文件外不改任何东西；不杀进程。
 *
 * 🔴 2026-10-11 加**超时保护**（施工单《15-》§4.10）：ws 打开 8s ／ 单次 CDP 响应 30s ／ 全局看门狗 90s。
 *    原版**无任何超时**，实测两次整体挂死（无法定位阶段）；现在超时即退出并报阶段。
 */
const fs = require('node:fs')

const args = process.argv.slice(2)
const port = args[0] || '9222'
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const has = (name) => args.includes(name)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const listUrl = 'http://127.0.0.1:' + port + '/json/list'
  let targets = []
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(listUrl)
      targets = await res.json()
      if (Array.isArray(targets) && targets.length) break
    } catch { /* 还没起来 */ }
    await sleep(500)
  }
  const page = targets.find((t) => t.type === 'page')
  if (!page) { console.error('[cdp] ✗ 没有 page target：' + JSON.stringify(targets).slice(0, 300)); process.exit(1) }
  console.log('[cdp] page = ' + page.title + '  url=' + page.url)

  // 🔴 超时保护（2026-10-11，施工单 15- §4.10）：三段分别兜底，任何一段卡住都不会挂死
  const WATCHDOG_MS = 90000, WS_OPEN_MS = 8000, SEND_MS = 30000
  setTimeout(() => { console.error('[cdp] ✗ 全局看门狗 ' + (WATCHDOG_MS / 1000) + 's 到期，强制退出（exit 3）'); process.exit(3) }, WATCHDOG_MS)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const requests = []
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('ws 打开超时（' + (WS_OPEN_MS / 1000) + 's）')), WS_OPEN_MS)
    ws.onopen = () => { clearTimeout(t); res() }
    ws.onerror = (e) => { clearTimeout(t); rej(new Error('ws error: ' + (e.message || e.type || 'unknown'))) }
  })
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const slot = pending.get(msg.id)
      pending.delete(msg.id)
      clearTimeout(slot.timer)
      slot.res(msg)
    }
    if (msg.method === 'Network.requestWillBeSent' && msg.params && msg.params.request) {
      requests.push({ url: msg.params.request.url, method: msg.params.request.method, type: msg.params.type })
    }
  }
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id
    const timer = setTimeout(() => {
      if (pending.has(mid)) { pending.delete(mid); rej(new Error('CDP 响应超时（' + (SEND_MS / 1000) + 's）：' + method)) }
    }, SEND_MS)
    pending.set(mid, { res, timer })
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }))
  })

  if (has('--network')) { await send('Network.enable'); console.log('[cdp] Network 域已开') }

  const expr = flag('--eval')
  if (expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    const v = r.result && r.result.result ? r.result.result.value : undefined
    console.log('[cdp] eval = ' + JSON.stringify(v))
    if (r.result && r.result.exceptionDetails) console.log('[cdp] eval 异常 = ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300))
  }

  if (flag('--png')) {
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    const data = shot.result && shot.result.data
    if (!data) { console.error('[cdp] ✗ 截图失败'); } else { fs.writeFileSync(flag('--png'), Buffer.from(data, 'base64')); console.log('[cdp] 截图 → ' + flag('--png')) }
  }

  if (has('--network')) {
    await sleep(1500)
    console.log('[cdp] 本轮记录到的请求 ' + requests.length + ' 条：')
    for (const q of requests) console.log('   ' + q.method + ' ' + q.url)
    if (flag('--network')) { fs.writeFileSync(flag('--network'), JSON.stringify(requests, null, 2)); console.log('[cdp] 请求清单 → ' + flag('--network')) }
  }

  if (has('--close')) {
    const r = await send('Runtime.evaluate', { expression: 'window.close(); "closing"', returnByValue: true })
    console.log('[cdp] 已请求关窗：' + JSON.stringify(r.result && r.result.result && r.result.result.value))
  }
  ws.close()
  await sleep(300)
  process.exit(0)
}
main().catch((e) => { console.error('[cdp] ✗ ' + e.message); process.exit(1) })
