import { describe, it, expect } from 'vitest'
import { entityColor, relationColor, markerId, subgraphSpec, fullGraphSpec } from '../../src/viz/graph.ts'

describe('graph visual mapping', () => {
  it('maps entity types in Chinese and English to the same colour', () => {
    expect(entityColor('船舶装备')).toBe('#1E90FF')
    expect(entityColor('ship equipment')).toBe('#1E90FF')
    expect(entityColor('未知类型')).toBe('#98a2b3')
  })
  it('maps relation labels in Chinese and English to the same colour', () => {
    expect(relationColor('导致')).toBe('#45B7D1')
    expect(relationColor('causes')).toBe('#45B7D1')
  })
  it('sanitises marker ids', () => {
    expect(markerId('导致')).toBe('arw-导致')
    expect(markerId('a b')).toBe('arw-a_b')
  })
  it('builds the subgraph spec with radial layout and all labels', () => {
    const spec = subgraphSpec({ graph: { nodes: [
      { entityId: 'E1', name: 'a', type: 't', hop: 0 },
      { entityId: 'E2', name: 'b', type: 't', hop: 1 },
    ], links: [{ from: 'E1', to: 'E2', relation: '导致' }] } } as never, null)
    expect(spec.layout).toBe('radial-hop')
    expect(spec.labelMode).toBe('all')
    expect(spec.nodes[0].r).toBe(15)
    expect(spec.nodes[1].r).toBe(10)
    expect(spec.links[0].source).toBe('E1')
  })
  it('builds the full-graph spec with top labels and degree-based radius', () => {
    const spec = fullGraphSpec([
      { entityId: 'E1', name: 'a', type: 't', degree: 5 },
      { entityId: 'E2', name: 'b', type: 't', degree: 1 },
    ], [])
    expect(spec.layout).toBe('force')
    expect(spec.labelMode).toBe('top')
    expect(spec.nodes[0].r).toBe(15.5)
    expect(spec.nodes[1].r).toBe(10)
  })
})
