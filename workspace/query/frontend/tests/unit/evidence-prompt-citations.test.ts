import { describe, it, expect } from 'vitest'
import { assignCitations } from '../../../evidence-prompt/index.ts'
import type { EvidenceBundle } from '../../../shared/types'

function bundle(): EvidenceBundle {
  return {
    text: { evidences: [{ chunkId: 'C1' }, { chunkId: 'C2' }] },
    graph: { nodes: [{ entityId: 'E1' }, { entityId: 'E2' }] },
    citations: [],
  } as unknown as EvidenceBundle
}

describe('citation numbering (assignCitations)', () => {
  it('numbers text evidence first, then entities, contiguously from 1', () => {
    const b = bundle()
    assignCitations(b)
    expect(b.citations.map((c) => c.no)).toEqual([1, 2, 3, 4])
    expect(b.citations.map((c) => c.kind)).toEqual(['chunk', 'chunk', 'entity', 'entity'])
    expect(b.citations.map((c) => c.refId)).toEqual(['C1', 'C2', 'E1', 'E2'])
  })

  it('is idempotent (does not duplicate numbering)', () => {
    const b = bundle()
    assignCitations(b)
    assignCitations(b)
    expect(b.citations.length).toBe(4)
    expect(new Set(b.citations.map((c) => c.no)).size).toBe(4)
  })
})
