// 用途：实测 sandbox:true 下 preload 能否注入 window.shipApp（阶段 1.2 判据）
// 跑法：node_modules\electron\dist\electron.exe scripts\probe-shipapp.cjs <结果文件> <esm|cjs>
// 设计要点（2026-09-27 第 3 次修订）：一进程只测一次（第 2 次修订版在同一进程内连开两个窗口，
// 第二个窗口 loadURL('about:blank') 报 ERR_FAILED(-2)，是探针写法问题而非 preload 问题）；
// 用真实 file:// 页面；20 秒看门狗；结果写文件；无论成败都 app.exit()，不留孤儿进程。
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const scriptsDir = __dirname
const frontendDir = path.join(scriptsDir, '..')
const mode = (process.argv[3] || 'esm').toLowerCase()
const outFile = process.argv[2] || path.join(scriptsDir, '.probe-result-' + mode + '.json')
const pageFile = path.join(scriptsDir, '.probe-page.html')
const esmPreload = path.join(frontendDir, 'dist-electron', 'preload.js')
const cjsPreload = path.join(scriptsDir, '.probe-preload.cjs')

const result = {
  startedAt: new Date().toISOString(),
  mode: mode,
  electron: process.versions.electron,
  node: process.versions.node,
  chrome: process.versions.chrome,
  finished: false,
  timedOut: false,
  fatal: null,
  probe: null
}

function flush(code) {
  try { fs.writeFileSync(outFile, JSON.stringify(result, null, 2)) } catch (e) {}
  try { console.log(JSON.stringify(result, null, 2)) } catch (e) {}
  app.exit(code)
}

const watchdog = setTimeout(() => { result.timedOut = true; flush(3) }, 20000)
process.on('unhandledRejection', (e) => { result.fatal = 'unhandledRejection: ' + ((e && e.message) || String(e)); clearTimeout(watchdog); flush(4) })
process.on('uncaughtException', (e) => { result.fatal = 'uncaughtException: ' + ((e && e.message) || String(e)); clearTimeout(watchdog); flush(4) })

function makeCjsPreload() {
  fs.writeFileSync(cjsPreload, [
    "const { contextBridge } = require('electron')",
    "contextBridge.exposeInMainWorld('shipApp', { platform: process.platform, version: process.versions.electron, probe: 'cjs' })",
    ''
  ].join('\n'))
}

app.whenReady()
  .then(async () => {
    try {
      fs.writeFileSync(pageFile, '<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head><body>probe page</body></html>')
      if (mode === 'cjs') makeCjsPreload()
      const preloadPath = mode === 'cjs' ? cjsPreload : esmPreload
      const errors = []
      const probe = { mode: mode, preloadPath: preloadPath, preloadExists: fs.existsSync(preloadPath), typeofShipApp: null, value: null, errors: errors }
      result.probe = probe
      const win = new BrowserWindow({
        show: false,
        webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
      })
      win.webContents.on('preload-error', (_e, p, err) => errors.push('preload-error: ' + p + ' :: ' + ((err && err.message) || String(err))))
      await win.loadFile(pageFile)
      probe.typeofShipApp = await win.webContents.executeJavaScript('typeof window.shipApp')
      probe.value = await win.webContents.executeJavaScript('window.shipApp ? JSON.stringify(window.shipApp) : null')
      win.destroy()
      result.finished = true
      clearTimeout(watchdog)
      flush(0)
    } catch (e) {
      result.fatal = 'main: ' + ((e && e.message) || String(e))
      clearTimeout(watchdog)
      flush(2)
    }
  })
  .catch((e) => { result.fatal = 'whenReady: ' + ((e && e.message) || String(e)); clearTimeout(watchdog); flush(5) })
