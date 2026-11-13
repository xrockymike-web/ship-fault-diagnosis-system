/**
 * 语言上下文（迁移期与旧翻译层并存；迁移完成后删除旧层）。
 * 语言是渲染的输入：切换 = setState，不刷新页面。
 */
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { en, type Msg } from './messages'

export type Locale = 'zh' | 'en'
const KEY = 'shipapp.locale'
type Vars = Record<string, string | number>

export function currentLocale(): Locale {
  try {
    return localStorage.getItem(KEY) === 'en' ? 'en' : 'zh'
  } catch {
    return 'zh'
  }
}

function fill(s: string, vars?: Vars): string {
  if (!vars) return s
  return s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''))
}

export function translate(m: Msg, vars?: Vars): string {
  return fill(currentLocale() === 'en' ? (en[m] ?? m) : m, vars)
}

interface Ctx {
  locale: Locale
  setLocale: (l: Locale) => void
  t: (m: Msg, vars?: Vars) => string
}
const LangCtx = createContext<Ctx | null>(null)

export function LangProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(currentLocale)
  const value = useMemo<Ctx>(() => ({
    locale,
    setLocale: (l: Locale) => {
      try { localStorage.setItem(KEY, l) } catch { /* 忽略 */ }
      document.documentElement.lang = l === 'en' ? 'en' : 'zh-CN'
      setLocaleState(l)
    },
    t: (m, vars) => fill(locale === 'en' ? (en[m] ?? m) : m, vars),
  }), [locale])
  return <LangCtx.Provider value={value}>{children}</LangCtx.Provider>
}

export function useI18n(): Ctx {
  const v = useContext(LangCtx)
  if (!v) throw new Error('useI18n 必须在 LangProvider 内使用')
  return v
}
export function useT(): Ctx['t'] {
  return useI18n().t
}
export const t = translate
export const tr = translate

export function useLocale(): Locale {
  return useI18n().locale
}
export function LanguageToggle() {
  const { locale, setLocale } = useI18n()
  const next: Locale = locale === 'en' ? 'zh' : 'en'
  return (
    <button
      type="button"
      className="lang-toggle"
      onClick={() => setLocale(next)}
      title={locale === 'en' ? '切换到中文' : 'Switch to English'}
      style={{
        marginLeft: 8, padding: '2px 10px', fontSize: 12, lineHeight: '18px',
        border: '1px solid var(--border, #d9d9df)', borderRadius: 999,
        background: 'var(--panel, #fff)', color: 'inherit', cursor: 'pointer',
      }}
    >
      {locale === 'en' ? '中文' : 'EN'}
    </button>
  )
}
