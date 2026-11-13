import { contextBridge, ipcRenderer } from 'electron'

// ⚠️ 本文件必须编译成 **CJS**（D-1.2-2）：
//    sandbox: true 下 Electron 不接受 ESM preload，表现为 window.shipApp **完全不注入**。
//    实测证据：交接文档/验收记录/阶段1.2/02-preload-probe.md。
//    CJS 由「frontend/package.json 不带 type: module」保证；改这里之前先确认产物仍是 require 形式。
//
// API 形状按施工单 §16.6「方案甲：端口/状态走 IPC」+ 目标 2.2「数据走 MessagePort」——
// 渲染进程不读文件、不打网络：状态与配置经 IPC，**对话数据经后端端口**。

export interface ServiceStatus {
  state: 'starting' | 'ready' | 'error'
  port?: number
  message?: string
  logPath?: string
}

/** 🆕 v0.3.2：档位信息（主进程下发；渲染进程**只读**。
 *  形状与 `src/types.ts` 的 `DialInfo` 保持一致 —— 本文件与 `src/` 刻意不互相 import
 *  （先例：上面的 `ServiceStatus` 也是各自声明一份），避免把 src 代码拖进 preload 包。 */
export interface DialInfo {
  dial: 'cpu' | 'cuda'
  snapshot: unknown | null
  firstTokenMs: number
  totalMs: number
  notice: { cpu: string; waiting: string }
}

// ---------------------------------------------------------------------------
// 后端端口（目标 2.2）：MessagePort **不能**直接过 contextBridge，
// 所以端口留在 preload 这一侧，只把 send/subscribe 两个函数暴露出去。
// ---------------------------------------------------------------------------
let backendPort: MessagePort | null = null
const queue: unknown[] = []
const listeners = new Set<(evt: unknown) => void>()

ipcRenderer.on('backend:port', (event) => {
  const port = event.ports && event.ports[0]
  if (!port) {
    console.warn('[preload] backend:port 事件里没有端口')
    return
  }
  if (backendPort) {
    // 窗口重载会再推一次端口：旧的随旧渲染进程一起消失，这里直接换新的
    try { backendPort.close() } catch { /* 忽略 */ }
  }
  backendPort = port
  port.onmessage = (ev: MessageEvent) => {
    for (const l of listeners) {
      try {
        l(ev.data)
      } catch (err) {
        console.warn('[preload] 后端事件处理失败：', (err as Error).message)
      }
    }
  }
  port.start()
  for (const m of queue.splice(0)) port.postMessage(m)
  port.postMessage({ kind: 'renderer-ready' })
  console.log('[preload] 后端端口已接入')
})

contextBridge.exposeInMainWorld('shipApp', {
  platform: process.platform,
  version: process.versions.electron,
  /** 取当前模型服务状态（窗口刚打开时用） */
  getServiceStatus: (): Promise<ServiceStatus> => ipcRenderer.invoke('service:getStatus'),
  /** 订阅状态变化；返回取消订阅函数 */
  onServiceStatus: (cb: (s: ServiceStatus) => void): (() => void) => {
    const listener = (_e: unknown, s: ServiceStatus) => cb(s)
    ipcRenderer.on('service:status', listener)
    return () => ipcRenderer.removeListener('service:status', listener)
  },
  /** 重启模型服务（§16.4 的「重试」按钮用） */
  restartService: (): Promise<ServiceStatus> => ipcRenderer.invoke('service:restart'),
  /** 🆕 v0.3.2：档位 + 按档超时 + 界面提示（只读；**没有切换入口**） */
  getDial: (): Promise<DialInfo> => ipcRenderer.invoke('dial:get'),

  /** 目标 2.2：把请求发给后端进程（端口未就绪时先排队，不静默丢） */
  sendToBackend: (msg: unknown): void => {
    if (backendPort) backendPort.postMessage(msg)
    else queue.push(msg)
  },
  /** 目标 2.2：订阅后端事件；返回取消订阅函数 */
  onBackendMessage: (cb: (evt: unknown) => void): (() => void) => {
    listeners.add(cb)
    return () => listeners.delete(cb)
  },
  /** 目标 2.2：后端端口是否已接入（诊断用） */
  backendReady: (): boolean => backendPort !== null,
})
