/**
 * 用户知识库的前端状态（U2）。
 *
 * 分层：`KnowledgePage` → `useUserKb`（状态 + 变更）→ `kb/api`（域）→ `backend/client`（传输）。
 * 纪律：**失败必须显示**（校验错误由后端给出中文消息，界面原样显示，不吞）。
 */
import { useCallback, useEffect, useState } from 'react'
import type { UserKbSnapshot } from '../../../shared/types'
import * as api from './api'

export interface UserKbController {
  snapshot: UserKbSnapshot | null
  loading: boolean
  error: string | null
  reload: () => void
  /** 跑一次变更：成功返回 warnings（要显示给用户），失败**抛出**由调用方显示 */
  mutate: (fn: (s: UserKbSnapshot) => Promise<{ warnings: string[] }>) => Promise<string[]>
}

export function useUserKb(): UserKbController {
  const [snapshot, setSnapshot] = useState<UserKbSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(() => {
    setLoading(true)
    api
      .listUserKb()
      .then((s) => {
        setSnapshot(s)
        setError(null)
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => reload(), [reload])

  const mutate = useCallback(
    async (fn: (s: UserKbSnapshot) => Promise<{ warnings: string[] }>) => {
      if (!snapshot) throw new Error('知识库还没读进来，稍候再试')
      const r = await fn(snapshot)
      reload()
      return r.warnings
    },
    [snapshot, reload],
  )

  return { snapshot, loading, error, reload, mutate }
}
