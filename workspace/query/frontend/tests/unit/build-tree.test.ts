import { describe, it, expect } from 'vitest'
import { buildTree, treeDepth, treeLeafCount, treeNodeCount } from '../../../shared/build-tree.ts'
import type { EvidenceBundle } from '../../../shared/types'

function emptyBundle(over: Record<string, unknown> = {}): EvidenceBundle {
  return {
    bundleVersion: 'test', question: '', createdAt: 0, status: {},
    text: { evidences: [] },
    graph: { seeds: [], nodes: [], links: [], causalPaths: [], cooccurrencePaths: [], noPath: false },
    diagnostics: { paths: [] },
    citations: [], evidenceLevel: 'sufficient', highestSimilarity: null,
    ...over,
  } as unknown as EvidenceBundle
}

function fixture(): EvidenceBundle {
  return emptyBundle({
    question: '发电机电压过低是什么原因？',
    graph: {
      seeds: [{ entityId: 'E1', name: '发电机', type: '船舶装备', evidenceChunkIds: [], from: {}, score: 0.9 }],
      nodes: [
        { entityId: 'E1', name: '发电机', type: '船舶装备', hop: 0 },
        { entityId: 'E2', name: '电压低', type: '故障现象', hop: 1 },
        { entityId: 'E3', name: '励磁故障', type: '故障原因', hop: 1 },
      ],
      links: [
        { from: 'E1', fromName: '发电机', to: 'E2', toName: '电压低', relation: '发生', evidenceChunkIds: [] },
        { from: 'E2', fromName: '电压低', to: 'E3', toName: '励磁故障', relation: '导致', evidenceChunkIds: [] },
      ],
      causalPaths: [], cooccurrencePaths: [], noPath: false,
    },
    diagnostics: { paths: [{
      score: 0.8,
      phenomenon: { name: '电压低', type: '故障现象' },
      cause: { name: '励磁故障', type: '故障原因' },
      measures: [{ name: '检查励磁回路', type: '维修步骤' }],
    }] },
  })
}

describe('diagnostic tree (build-tree)', () => {
  it('returns null when evidence level is insufficient (the gate)', () => {
    const b = fixture()
    ;(b as unknown as { evidenceLevel: string }).evidenceLevel = 'insufficient'
    expect(buildTree(b)).toBeNull()
  })

  it('returns null when there are no paths and no links', () => {
    expect(buildTree(emptyBundle({ question: '发电机为什么报警' }))).toBeNull()
  })

  it('builds a tree anchored at the question entity', () => {
    const t = buildTree(fixture())
    expect(t).not.toBeNull()
    expect(t!.name).toBe('发电机')
    expect(treeNodeCount(t)).toBeGreaterThan(1)
    expect(treeDepth(t)).toBeGreaterThanOrEqual(2)
    expect(treeLeafCount(t)).toBeGreaterThanOrEqual(1)
  })

  it('is deterministic: the same bundle yields the same tree', () => {
    const a = JSON.stringify(buildTree(fixture()))
    const b = JSON.stringify(buildTree(fixture()))
    expect(a).toBe(b)
  })
})
