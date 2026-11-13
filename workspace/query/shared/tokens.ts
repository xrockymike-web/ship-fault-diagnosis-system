/**
 * 型号 / 编号记号 —— **单一实现**（A5 召回保险用的那一份正则）
 *
 * 2026-10-22：原先 `text-retrieval` 与 `graph-retrieval` 各抄了一份（逐字相同），收口到这里。
 * 为什么必须同一份：同一句问题在两路里要被切成**同一组型号词**，否则文本路与图路的召回口径
 * 对不上，A/B 里也说不清差异来自哪一路。
 *
 * 纪律：本文件零依赖（无 node: 内建、无 React）—— 会被后端（Node）与前端打包共用。
 */

const TOKEN_RE = /[A-Za-z0-9][A-Za-z0-9.\-_/]*/g

/** 型号 / 编号：含数字的连续记号（各种破折号归一为 '-'），去重后返回；**只做召回保险** */
export function patternTokens(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(TOKEN_RE)) {
    const t = m[0].replace(/[\u2010\u2011\u2013\u2014]/g, '-')
    if (t.length < 2 || !/[0-9]/.test(t)) continue
    out.push(t)
  }
  return [...new Set(out)]
}
