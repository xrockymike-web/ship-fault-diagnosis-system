const fs = require('fs');
const port = 9222;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function main() {
  const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let i = 0; const pend = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } };
  const send = (m, p) => new Promise(r => { const id = ++i; pend.set(id, r); ws.send(JSON.stringify({ id, method: m, params: p || {} })) });
  const ev = async x => { const rr = await send('Runtime.evaluate', { expression: x, returnByValue: true }); return rr.result && rr.result.result ? rr.result.result.value : undefined };
  await ev('window.__probe = 42');
  const before = await ev('document.body.innerText');
  await ev("document.querySelector('.lang-toggle').click()");
  await sleep(1800);
  const probe = await ev('window.__probe');
  const after = await ev('document.body.innerText');
  const locale = await ev("localStorage.getItem('shipapp.locale')");
  const evText = (await ev("(() => { const e = document.querySelector('.evidence-panel, .evidence'); return e ? e.innerText : '' })()")) || '';
  console.log(JSON.stringify({ noReload: probe === 42, locale, beforeHan: (before.match(/[\u4e00-\u9fff]/g)||[]).length, afterHan: (after.match(/[\u4e00-\u9fff]/g)||[]).length, evidenceHead: evText.slice(0, 220) }, null, 1));
  const sh = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('workspace/build/lang/out/instant-' + locale + '.png', Buffer.from(sh.result.data, 'base64'));
  ws.close();
}
main().catch(e => { console.error('FAIL', e.message); process.exit(1) });