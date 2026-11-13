import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { en } from '../../src/lang/messages.ts'

const SRC = fileURLToPath(new URL('../../src', import.meta.url))

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(ent.name) && !ent.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** Collect literal keys used via tr("...") / tr('...') in the UI sources. */
function usedKeys(): string[] {
  const re = /\btr\(\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)')/g
  const keys = new Set<string>()
  for (const f of walk(SRC)) {
    const text = readFileSync(f, 'utf8')
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) keys.add(m[1] !== undefined ? m[1] : m[2])
  }
  return [...keys]
}

describe('i18n completeness', () => {
  it('scans a meaningful number of literal tr() keys', () => {
    expect(usedKeys().length).toBeGreaterThan(80)
  })

  it('every literal tr() key has a non-empty English string', () => {
    const missing: string[] = []
    for (const k of usedKeys()) {
      const v = (en as Record<string, string>)[k]
      if (typeof v !== 'string' || v.length === 0) missing.push(k)
    }
    expect(missing).toEqual([])
  })

  it('key UI strings are translated (spot checks)', () => {
    expect((en as Record<string, string>)['知识图谱全貌']).toBe('Knowledge graph overview')
    expect((en as Record<string, string>)['只看自建']).toBe('Custom only')
    expect((en as Record<string, string>)['描述设备现象或故障，例如：电磁制动器吸合后马上又释放是哪些原因引起的？']).toContain('Describe the symptom')
    expect((en as Record<string, string>)['拖动节点摆位置 · 双击节点恢复自动布局 · 右下 ⌂ 一次重排全部 · 滚轮缩放 · 拖动空白处平移 · 点节点高亮邻居']).toContain('Drag nodes to arrange')
  })
})
