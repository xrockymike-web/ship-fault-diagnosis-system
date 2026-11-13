#!/usr/bin/env node
/** 英文模式验收：切换语言 → 截图 → 英文提问 → 取回答与证据 → 统计中文残留。 */
const fs = require('node:fs')
const port = process.argv[2] || '9222'
const outDir = process.argv[3] || 'workspace/build/lang/out'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')) })
  let seq = 0
  const pending = new Map()
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const send = (method, params) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params: params || {} })) })
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.result && r.result.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300))
    return r.result && r.result.result ? r.result.result.value : undefined
  }
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(outDir + '/' + name, Buffer.from(r.result.data, 'base64'))
    return outDir + '/' + name
  }
  await send('Page.enable')
  await send('Runtime.enable')

  // 1) 切到英文（写 localStorage + 重载）
  await evaluate("localStorage.setItem('shipapp.locale','en'); 'ok'")
  await send('Page.reload', { ignoreCache: true })
  await sleep(6000)

  // 2) 等模型就绪 + 截图英文界面
  for (let i = 0; i < 60; i++) {
    const ready = await evaluate("!!document.querySelector('.btn-send') && (document.body.innerText.includes('Model ready') || document.body.innerText.includes('模型就绪'))")
    if (ready) break
    await sleep(2000)
  }
  await sleep(1500)
  await evaluate("(() => { const b = document.querySelector('.btn-new, .btn-new-rail'); if (b) b.click(); return 'ok' })()")
  await sleep(1500)
  const uiText = await evaluate('document.body.innerText')
  const han = (uiText.match(/[\u4e00-\u9fff]/g) || []).length
  await shot('en-ui.png')

  // 3) 英文提问
  const ask = (text) => [
    "const ta = document.querySelector('textarea');",
    "if (!ta) return 'no-textarea';",
    "const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;",
    "setter.call(ta, " + JSON.stringify(text) + ");",
    "ta.dispatchEvent(new Event('input', { bubbles: true }));",
    "await new Promise(r => setTimeout(r, 200));",
    "const btn = document.querySelector('.btn-send');",
    "if (!btn) return 'no-send';",
    "btn.click();",
    "return 'ok';",
  ].join('\n')
  const sent = await evaluate('(async () => {' + ask('How do I test the insulation resistance of a marine generator?') + '})()')
  let answer = ''
  for (let i = 0; i < 240; i++) {
    await sleep(1000)
    answer = await evaluate("(() => { const els = document.querySelectorAll('.msg-content'); return els.length ? els[els.length-1].textContent : '' })()") || ''
    const done = await evaluate("!!document.querySelector('.btn-rerun')")
    if (done && answer.length > 30) break
  }
  await sleep(1500)
  const pageText = await evaluate('document.body.innerText')
  const hanAfter = (pageText.match(/[\u4e00-\u9fff]/g) || []).length
  await shot('en-answer.png')

  await evaluate("(() => { const t = document.querySelector('.ev-title'); if (t) { const c = t.closest('button') || t.parentElement; if (c) c.click() } return 'ok' })()")
  await sleep(1200)
  await shot('en-evidence.png')
  const evidence = await evaluate("(() => { const e = document.querySelector('.evidence-panel, .ev-panel, .evidence'); return e ? e.innerText.slice(0, 2500) : document.body.innerText.slice(0, 2500) })()")
  await evaluate("(() => { const b = document.querySelectorAll('.rail-nav'); if (b.length > 1) b[1].click(); return 'ok' })()")
  await sleep(4000)
  await shot('en-graph.png')
  const graphText = (await evaluate('document.body.innerText')) || ''
  const graphHan = (graphText.match(/[\u4e00-\u9fff]/g) || []).length
  const out = { graphHan, sent, answerChars: answer.length, answer: answer.slice(0, 1200), uiHanBefore: han, pageHanAfter: hanAfter, evidence: String(evidence).slice(0, 1200) }
  fs.writeFileSync(outDir + '/en-verify.json', JSON.stringify(out, null, 1))
  console.log(JSON.stringify(out, null, 1))
  ws.close()
}
main().catch((e) => { console.error('FAIL', e.message); process.exit(1) })