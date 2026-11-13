import { describe, it, expect } from 'vitest'
import { assignCitations, formatTextSection } from '../../../evidence-prompt/index.ts'
import type { EvidenceBundle } from '../../../shared/types'

const cfg = { prompt: { budgetTokens: { textEvidence: 3400 }, evidenceCharLimitPerItem: 20 } } as unknown as Parameters<typeof formatTextSection>[1]

describe('evidence section formatting', () => {
  it('reports the empty case explicitly', () => {
    const b = { text: { evidences: [] } } as unknown as EvidenceBundle
    expect(formatTextSection(b, cfg)).toBe('【原文证据】（无）')
  })

  it('prints the citation number and the chunk id', () => {
    const b = {
      text: { evidences: [{ chunkId: 'C1', kind: 'parent', text: 'short text', matches: [], score: 0.5 }] },
      graph: { nodes: [] }, citations: [],
    } as unknown as EvidenceBundle
    assignCitations(b)
    const s = formatTextSection(b, cfg)
    expect(s).toContain('【原文证据】')
    expect(s).toContain('[1] 块 C1')
    expect(s).toContain('short text')
  })

  it('truncates long items explicitly (never silently)', () => {
    const b = {
      text: { evidences: [{ chunkId: 'C1', kind: 'parent', text: 'A'.repeat(80), matches: [], score: 0.5 }] },
      graph: { nodes: [] }, citations: [],
    } as unknown as EvidenceBundle
    assignCitations(b)
    const s = formatTextSection(b, cfg)
    expect(s).toContain('…（已截）')
    expect(s.length).toBeLessThan(120)
  })
})
