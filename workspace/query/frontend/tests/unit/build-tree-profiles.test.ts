import { describe, it, expect } from 'vitest'
import { classifyQuestion, PROFILES } from '../../../shared/build-tree.ts'

describe('question profiles', () => {
  it('classifies fault questions (incl. the fault-first priority)', () => {
    expect(classifyQuestion('发电机电压过低是什么原因？')).toBe('fault')
    expect(classifyQuestion('怎么处理跳闸故障')).toBe('fault')
  })
  it('classifies maintenance questions', () => {
    expect(classifyQuestion('主机的保养项目有哪些')).toBe('maint')
    expect(classifyQuestion('维护周期怎么定')).toBe('maint')
  })
  it('classifies operation/measurement questions', () => {
    expect(classifyQuestion('绝缘电阻怎么测量')).toBe('oper')
    expect(classifyQuestion('绝缘电阻的测量步骤')).toBe('oper')
  })
  it('falls back to fault for unmatched questions', () => {
    expect(classifyQuestion('RCU 是什么')).toBe('fault')
  })
  it('exposes consistent profile configs', () => {
    expect(Object.keys(PROFILES).sort()).toEqual(['fault', 'maint', 'oper'])
    for (const p of Object.values(PROFILES)) {
      expect(p.typePrior.length).toBeGreaterThan(0)
      expect(p.measureRels.length).toBeGreaterThan(0)
    }
    expect(PROFILES.fault.measureRels).toContain('对应')
  })
})
