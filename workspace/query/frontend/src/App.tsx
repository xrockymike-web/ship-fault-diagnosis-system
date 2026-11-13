import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Message, ServiceStatus, Session } from './types'
import { createSession, loadSidebarCollapsed, newId, saveSidebarCollapsed } from './storage'
// 目标 2.5：会话读写全部走后端（渲染进程不碰文件，红线 R4；不再用 localStorage，D2-12）
import { deleteSession, listSessions, saveSession } from './sessions'
// 目标 2.2：对话流经 MessagePort 交给后端进程（D2-11 / D2-13）。
// 提示词与模型参数**都不再进渲染进程** —— payload 由 qa-core + evidence-prompt 构造。
import { createChatStream } from './hooks/useChatStream'
// 🆕 v0.3.2：档位（只读：超时值 + 界面提示语）
import { currentDial, loadDial } from './dial'
import type { DialInfo } from './types'
import Sidebar from './components/Sidebar'
import { LanguageToggle, useLocale } from './lang/provider'
import MessageList from './components/MessageList'
import GraphPage from './components/GraphPage'
import KnowledgePage from './kb/KnowledgePage'
import Composer from './components/Composer'
import ConfirmDialog from './components/ConfirmDialog'
import { tr } from './lang/provider'

/** 空态示例问题（§15.2 缺口 7）：点一下直接提问 */
export const EXAMPLE_QUESTIONS = [
  '发电机电压过低是什么原因，怎么处理？',
  '1+1 等于多少？',
  '热继电器不动作怎么排查？',
]

export default function App() {
  // 目标 2.5：会话来自后端会话库（异步读取）；先用一个空会话占位，读到后整体替换
  const [sessions, setSessions] = useState<Session[]>(() => [createSession()])
  const [activeId, setActiveId] = useState<string>('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<boolean>(() => loadSidebarCollapsed())
  const locale = useLocale()
  // 语言是渲染输入：订阅 locale，切换时整棵树重渲染（不刷新页面）
  /** 目标 5：三份图的全局收起态（单个图块各自还能收） */
  const [figsCollapsed, setFigsCollapsed] = useState<boolean>(false)
  /** 目标 5 · ①：页面（问答 / 知识图谱全貌）；U2 追加第三页「知识管理」 */
  const [page, setPage] = useState<'chat' | 'graph' | 'knowledge'>('chat')
  /** 待删除的会话（应用内确认浮层用；替代原生 window.confirm） */
  const [pendingDelete, setPendingDelete] = useState<Session | null>(null)
  /** 正在生成的会话 id（null = 空闲）；§15.2 缺口 3 */
  const [generatingIn, setGeneratingIn] = useState<string | null>(null)
  const streamRef = useRef<{ abort(): void } | null>(null)
  /** 模型服务状态（1.4）：窗口出现时先拿一次，之后由主进程推送 */
  const [service, setService] = useState<ServiceStatus>({ state: 'starting', message: '正在启动…' })
  /** 🆕 v0.3.2：档位（**只读**；决定超时值与界面提示语；前端没有切换入口） */
  const [dial, setDial] = useState<DialInfo>(() => currentDial())

  useEffect(() => {
    const api = window.shipApp
    if (!api) {
      // 这条本身就是判据：preload 若不是 CJS，shipApp 根本不存在（1.2 证据 02）
      setService({ state: 'error', message: 'window.shipApp 未注入：preload 可能不是 CJS 形态（见阶段1.2 证据 02）' })
      return
    }
    let alive = true
    void api.getServiceStatus().then((s) => {
      if (alive) setService(s)
    })
    // 🆕 v0.3.2：拉一次档位（拿不到就保持兜底的 GPU 档值，不静默变 0）
    void loadDial().then((d) => {
      if (alive) setDial(d)
    })
    const off = api.onServiceStatus((s) => setService(s))
    return () => {
      alive = false
      off()
    }
  }, [])

  // 目标 2.5：开机读会话库（data/runtime/sessions.sqlite）；读不到就保持空会话，**不静默假装成功**
  useEffect(() => {
    let alive = true
    void listSessions()
      .then((list) => {
        if (!alive || list.length === 0) return
        setSessions(list)
        setActiveId((prev) => prev || list[0].id)
      })
      .catch((err: Error) => console.warn('[sessions] 读取会话失败：', err.message))
    return () => {
      alive = false
    }
  }, [locale])

  const modelReady = service.state === 'ready'

  const handleRestartService = useCallback(() => {
    setService({ state: 'starting', message: '正在重启模型服务…' })
    void window.shipApp?.restartService()
  }, [])

  useEffect(() => {
    if (!activeId && sessions.length > 0) setActiveId(sessions[0].id)
  }, [sessions, activeId])

  // 目标 2.5：按会话落库。**流式期间不写**（chat 的起止由后端直接写库），
  // 生成结束/改名/新增/改标题时才写 —— 一次 DB 写入，不是每个 token 一次。
  useEffect(() => {
    const s = sessions.find((x) => x.id === activeId) ?? sessions[0]
    if (!s || generatingIn === s.id) return
    // ⚠️ 空会话**不落库**：开机占位/刚点「新会话」还没提问时，写进去只会让库里堆一串"新会话"
    //    （2026-09-27 实测：修之前每次启动 +1 个空会话）。真发第一句话时后端会在 chat 起点建行。
    if (s.messages.length === 0) return
    void saveSession(s).catch((err: Error) => console.warn('[sessions] 保存失败：', err.message))
  }, [sessions, activeId, generatingIn])

  /** 离开生成中的会话时不允许（简化：只允许在当前会话停止） */
  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeId) ?? sessions[0],
    [sessions, activeId],
  )
  const generating = generatingIn !== null && generatingIn === activeSession?.id
  /** 🆕 v0.3.2：还在等首个 token → 显示「模型思考 / 检索材料中…」掩盖等待（P0-5） */
  const waitingFirstToken =
    generating &&
    !(activeSession?.messages.some((m) => m.role === 'assistant' && m.status === 'streaming' && m.content.length > 0) ?? false)

  const updateSession = useCallback((id: string, updater: (s: Session) => Session) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? updater(s) : s)))
  }, [])

  /** 跑一次「回答生成」：先插入空的 assistant 消息，再由流逐字填充 */
  const runStream = useCallback((sessionId: string, history: Message[]) => {
    const assistantId = newId()
    const startedAt = Date.now()
    const patch = (fn: (m: Message) => Message) => {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? { ...s, messages: s.messages.map((m) => (m.id === assistantId ? fn(m) : m)) }
            : s,
        ),
      )
    }

    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId
          ? {
              ...s,
              updatedAt: startedAt,
              messages: [
                ...s.messages,
                { id: assistantId, role: 'assistant' as const, content: '', createdAt: startedAt, status: 'streaming' as const },
              ],
            }
          : s,
      ),
    )
    setGeneratingIn(sessionId)

    // 目标 2.2：渲染进程**不再直连模型服务**（临时妥协 #1 已归还）—— 这里只把请求交给后端。
    // 接口没变（这正是 1.3 抽象出 ChatStream 的意义），所以界面组件一行没动。
    if (service.state !== 'ready') {
      patch((m) => ({
        ...m,
        status: 'error',
        finishedAt: Date.now(),
        error: '模型服务尚未就绪，无法生成回答。可在顶部状态条点「重试」。',
      }))
      setGeneratingIn(null)
      return
    }
    streamRef.current = createChatStream({
      sessionId,
      assistantMessageId: assistantId,
    }).start({
      messages: history.map((m) => ({ role: m.role, content: m.content })),
      userMessageId: history[history.length - 1]?.id,
      onDelta: (text) =>
        patch((m) => ({
          ...m,
          content: m.content + text,
          firstTokenAt: m.firstTokenAt ?? Date.now(),
        })),
      onDone: (evidence) => {
        // 目标 5：证据包随 chat.done 到达 —— 存进这条消息（渲染面板 + 三图用）
        patch((m) => ({ ...m, status: 'done', finishedAt: Date.now(), evidence: evidence ?? null }))
        setGeneratingIn(null)
        streamRef.current = null
      },
      onError: (err) => {
        patch((m) => ({ ...m, status: 'error', error: err.message, finishedAt: Date.now() }))
        setGeneratingIn(null)
        streamRef.current = null
      },
    })
  }, [service.state])

  const handleSend = useCallback(
    (text: string) => {
      if (!activeSession || generating) return
      const now = Date.now()
      const isFirstMessage = activeSession.messages.length === 0
      const userMsg: Message = { id: newId(), role: 'user', content: text, createdAt: now, status: 'done' }
      const history = [...activeSession.messages, userMsg]
      updateSession(activeSession.id, (s) => ({
        ...s,
        title: isFirstMessage ? text.slice(0, 24) + (text.length > 24 ? '…' : '') : s.title,
        updatedAt: now,
        messages: history,
      }))
      runStream(activeSession.id, history)
    },
    [activeSession, generating, runStream, updateSession],
  )

  /** 停止生成（§15.2 缺口 4）：真的中断流，已有内容按"已生成部分"定稿 */
  const handleStop = useCallback(() => {
    const sid = generatingIn
    streamRef.current?.abort()
    streamRef.current = null
    setGeneratingIn(null)
    if (!sid) return
    updateSession(sid, (s) => ({
      ...s,
      messages: s.messages.map((m) =>
        m.status === 'streaming' ? { ...m, status: 'done', finishedAt: Date.now() } : m,
      ),
    }))
  }, [generatingIn, updateSession])

  /** 重新生成 / 重试（同一个动作：丢掉最后一条 assistant 消息，用同样的历史重跑） */
  const handleRerun = useCallback(() => {
    if (!activeSession || generating) return
    const msgs = activeSession.messages
    const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant')
    if (!lastAssistant) return
    const history = msgs.filter((m) => m.id !== lastAssistant.id)
    updateSession(activeSession.id, (s) => ({ ...s, messages: history }))
    runStream(activeSession.id, history)
  }, [activeSession, generating, runStream, updateSession])

  const handleNewSession = useCallback(() => {
    if (generating) handleStop()
    const s = createSession()
    setSessions((prev) => [s, ...prev])
    setActiveId(s.id)
    setRenamingId(null)
    // 点「新会话」必须回到问答页 —— 否则站在全貌页会"建了却看不见"
    setPage('chat')
  }, [generating, handleStop])

  const handleSelectSession = useCallback(
    (id: string) => {
      if (generating) handleStop()
      setActiveId(id)
      setRenamingId(null)
      // 点对话历史 → 直接显示该会话（从全貌页切回问答页）
      setPage('chat')
    },
    [generating, handleStop],
  )

  const handleDeleteSession = useCallback(
    (id: string) => {
      if (generatingIn === id) handleStop()
      // 目标 2.5：库里也要删（外键 CASCADE 会带走消息）
      void deleteSession(id).catch((err: Error) => console.warn('[sessions] 删除失败：', err.message))
      setSessions((prev) => {
        const next = prev.filter((s) => s.id !== id)
        if (next.length === 0) {
          const fresh = createSession()
          setActiveId(fresh.id)
          return [fresh]
        }
        if (id === activeId) setActiveId(next[0].id)
        return next
      })
    },
    [activeId, generatingIn, handleStop],
  )

  /** 点会话项的 ✕：只"请求"删除；真正的删除等浮层确认后再执行 */
  const handleAskDelete = useCallback((s: Session) => setPendingDelete(s), [])

  const handleConfirmDelete = useCallback(() => {
    if (pendingDelete) handleDeleteSession(pendingDelete.id)
    setPendingDelete(null)
  }, [pendingDelete, handleDeleteSession])

  const handleRenameSession = useCallback(
    (id: string, title: string) => {
      const trimmed = title.trim()
      updateSession(id, (s) => ({ ...s, title: trimmed.length > 0 ? trimmed : s.title }))
      setRenamingId(null)
    },
    [updateSession],
  )

  /** 侧边栏折叠（§15.2 缺口 9）：状态持久化，刷新后保持 */
  const toggleSidebar = useCallback(() => {
    setCollapsed((c) => {
      saveSidebarCollapsed(!c)
      return !c
    })
  }, [])

  return (
    <div className={`app-shell${collapsed ? ' sidebar-collapsed' : ''}`}>
      <Sidebar
        sessions={sessions}
        activeId={activeSession?.id ?? ''}
        renamingId={renamingId}
        collapsed={collapsed}
        page={page}
        onPage={setPage}
        onToggleCollapse={toggleSidebar}
        onNew={handleNewSession}
        onSelect={handleSelectSession}
        onStartRename={setRenamingId}
        onCommitRename={handleRenameSession}
        onCancelRename={() => setRenamingId(null)}
        onAskDelete={handleAskDelete}
      />
      <main className="main-pane">
        <header className="chat-header">
          <img className="header-icon" src={import.meta.env.BASE_URL + 'assets/anchor.svg'} alt="" />
          <span className="header-title">{page === 'graph' ? tr('知识图谱全貌') : page === 'knowledge' ? tr('知识管理') : (activeSession?.title ?? tr('船舶故障诊断系统'))}</span>
          <LanguageToggle />
          {/* 🆕 v0.3.2：档位提示 + 等待提示。用一个容器包住 —— 原来只有一个 .header-status
              （margin-left:auto），加第二个会把空档平分、布局散开。 */}
          <span className="header-notices">
            {generating && <span className="header-status">{waitingFirstToken ? dial.notice.waiting : tr('正在生成…')}</span>}
            {dial.dial === 'cpu' && <span className="header-status cpu">{tr("CPU 模式，回答较慢")}</span>}
            {modelReady && <span className="header-status ok">{tr("模型就绪")} · :{service.port}</span>}
          </span>
          {page === 'chat' && activeSession?.messages.some((m) => m.role === 'assistant' && m.status === 'done') && (
            <span className="global-tools">
              <span onClick={() => setFigsCollapsed((v) => !v)}>{figsCollapsed ? tr('展开所有图') : tr('收起所有图')}</span>
            </span>
          )}
        </header>
        {page === 'graph' ? (
          <GraphPage />
        ) : page === 'knowledge' ? (
          <KnowledgePage />
        ) : (
          <>
        {service.state === 'starting' && (
          <div className="service-bar loading">{tr("正在加载模型…（目标 0 实测约 1.6 秒）")}</div>
        )}
        {service.state === 'error' && (
          <div className="service-bar error">
            <span className="service-bar-icon">!</span>
            <span className="service-bar-text">{service.message}</span>
            <button className="btn-retry" onClick={handleRestartService}>{tr("重试")}</button>
          </div>
        )}
        <MessageList
          session={activeSession}
          generating={generating}
          examples={EXAMPLE_QUESTIONS}
          onAsk={handleSend}
          onRerun={handleRerun}
          figsCollapsed={figsCollapsed}
        />
        <Composer
          onSend={handleSend}
          onStop={handleStop}
          generating={generating}
          disabled={!activeSession || !modelReady}
        />
          </>
        )}
      </main>
      <ConfirmDialog
        open={pendingDelete !== null}
        title={tr("删除会话")}
        body={<>「{pendingDelete?.title}」将从本机永久删除，此操作不可撤销。</>}
        onConfirm={handleConfirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  )
}
