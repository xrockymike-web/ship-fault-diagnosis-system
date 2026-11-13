#!/usr/bin/env node
/** 中文回归：切回 zh，确认界面与回答仍是中文（英文层不得影响原路径）。 */
const fs = require('node:fs')
const port = process.argv[2] || '9222'
const outDir = process.argv[3] || 'workspace/build/lang/out'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
(async () => {
  const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
  const page = list.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')) })
  let seq = 0; const pending = new Map()
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const send = (method, params) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params: params || {} })) })
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : undefined }
  await send('Page.enable')
  await ev("localStorage.setItem('shipapp.locale','zh'); 'ok'")
  await send('Page.reload', { ignoreCache: true })
  await sleep(8000)
  const ui = await ev('document.body.innerText')
  const han = (ui.match(/[\u4e00-\u9fff]/g) || []).length
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(outDir + '/zh-regression.png', Buffer.from(shot.result.data, 'base64'))
  const ask = (text) => [
    "const ta = document.querySelector('textarea');",
    "const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;",
    'setter.call(ta, ' + JSON.stringify(text) + ');',
    "ta.dispatchEvent(new Event('input', { bubbles: true }));",
    'await new Promise(r => setTimeout(r, 200));',
    "document.querySelector('.btn-send').click();",
    "return 'ok';"
  ].join('\n')
  const sent = await ev('(async () => {' + ask('热继电器不动作怎么排查？请分点。') + '})()')
  let ans = ''
  for (let i = 0; i < 180; i++) {
    await sleep(1000)
    ans = (await ev("(() => { const e = document.querySelectorAll('.msg-content'); return e.length ? e[e.length-1].textContent : '' })()")) || ''
    if (ans.length > 30 && (await ev("!!document.querySelector('.btn-rerun')"))) break
  }
  const out = { sent, uiHan: han, answerChars: ans.length, answer: ans.slice(0, 300) }
  fs.writeFileSync(outDir + '/zh-regression.json', JSON.stringify(out, null, 1))
  console.log(JSON.stringify(out, null, 1))
  ws.close()
})().catch((e) => { console.error('FAIL', e.message); process.exit(1) })