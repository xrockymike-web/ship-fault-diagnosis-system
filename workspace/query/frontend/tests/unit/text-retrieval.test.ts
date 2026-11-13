import { describe, it, expect } from 'vitest'
import { segment, rrf } from '../../../text-retrieval/index.ts'
import { patternTokens } from '../../../shared/tokens.ts'

describe('query segmentation', () => {
  it('extracts model tokens and normalises dashes', () => {
    const t = patternTokens('RCU-12 与 DW14 断路器，型号 ABC-3')
    expect(t).toContain('RCU-12')
    expect(t).toContain('DW14')
    expect(t).toContain('ABC-3')
    expect(new Set(t).size).toBe(t.length)
  })

  it('segments by longest vocabulary match and appends extras', () => {
    const vocab = new Set(['发电机', '绝缘电阻', '测量'])
    const terms = segment('发电机绝缘电阻怎么测量', vocab, ['RCU-12'])
    expect(terms).toContain('发电机')
    expect(terms).toContain('绝缘电阻')
    expect(terms).toContain('测量')
    expect(terms).toContain('RCU-12')
    expect(new Set(terms).size).toBe(terms.length)
  })
})

describe('RRF fusion', () => {
  it('ranks items present in both lists first', () => {
    const a = [{ id: 'A', score: 0.9 }, { id: 'B', score: 0.8 }]
    const b = [{ id: 'B', score: 0.0 }, { id: 'C', score: 0.0 }]
    const fused = rrf(a, b, 60, new Map([['A', 0.9], ['B', 0.8]]))
    expect(fused[0].id).toBe('B')
    expect(fused.map((x) => x.id)).toEqual(['B', 'A', 'C'])
  })

  it('breaks ties by vector score', () => {
    const a = [{ id: 'X', score: 0.1 }]
    const b = [{ id: 'Y', score: 0.2 }]
    const fused = rrf(a, b, 60, new Map([['X', 0.1], ['Y', 0.9]]))
    expect(fused.map((x) => x.id)).toEqual(['Y', 'X'])
  })
})
