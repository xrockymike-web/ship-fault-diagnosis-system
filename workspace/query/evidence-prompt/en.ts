/** 英文提示词与六段式装配（与中文版同构；不依赖 index.ts 里的中文标签）。 */
import type { EvidenceBundle } from '../shared/types'

export const EN_PROMPTS = {
  system:
    'You are a fault-diagnosis assistant for shipboard electrical equipment. Answer in English, in short actionable bullet points; state uncertainty explicitly.',
  grounded:
    'You are a fault-diagnosis assistant for shipboard electrical equipment. Answer ONLY from the supplied material in English. ' +
    'If the material is insufficient, say "insufficient evidence" instead of guessing. ' +
    'Give the conclusion first in one sentence, then the cause, inspection or handling steps and cautions in logical order; ' +
    'merge the material into your own words instead of copying it line by line.',
  noEvidence:
    'No relevant evidence was found in the knowledge base. Try rephrasing, or add the equipment model and the observed symptom.',
  answerFormat:
    'Answer in bullets: likely causes first (most probable first), then the matching inspection or handling step for each.',
}

function hist(history: { role: string; content: string }[], opts: { historyTurns: number; historyCharLimit: number }) {
  const current = history[history.length - 1]
  const past = history.slice(0, -1)
  const keepFrom = Math.max(0, past.length - opts.historyTurns * 2)
  let kept = past.slice(keepFrom)
  let chars = kept.reduce((n, m) => n + m.content.length, 0) + (current?.content.length ?? 0)
  while (kept.length > 0 && chars > opts.historyCharLimit) { chars -= kept[0].content.length; kept = kept.slice(1) }
  return kept
}

export function buildGroundedMessagesEn(
  bundle: EvidenceBundle,
  history: { role: 'user' | 'assistant'; content: string }[],
  opts: { historyTurns: number; historyCharLimit: number },
): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  const current = history[history.length - 1]
  const kept = hist(history, opts)
  const cite = (kind: 'chunk' | 'entity', refId: string) => {
    const hit = bundle.citations.find((c) => c.kind === kind && c.refId === refId)
    return hit ? '[' + hit.no + ']' : ''
  }
  let used = 0
  const limit = 4800
  const parts: string[] = ['[Original evidence]']
  for (const e of bundle.text.evidences) {
    const head = '· ' + cite('chunk', e.chunkId) + ' block ' + e.chunkId
    const body = e.text.length > 1200 ? e.text.slice(0, 1200) + '… (truncated)' : e.text
    const block = head + '\n' + body
    if (used + block.length > limit) { parts.push(head + '\n… (budget reached)'); break }
    parts.push(block); used += block.length
  }
  const g = bundle.graph
  if (g.nodes.length > 0 || g.links.length > 0) {
    parts.push('[Knowledge graph · local subgraph] nodes ' + g.nodes.length + ' / edges ' + g.links.length)
    if (g.nodes.length > 0) parts.push('Entities: ' + g.nodes.slice(0, 15).map((n) => n.name + ' (' + n.type + ')').join('; '))
    const byRel = new Map<string, string[]>()
    for (const l of g.links) { if (!byRel.has(l.relation)) byRel.set(l.relation, []); byRel.get(l.relation)!.push(l.fromName + ' -> ' + l.toName) }
    for (const [rel, list] of byRel) parts.push(rel + ': ' + list.slice(0, 8).join('; '))
  }
  if (bundle.diagnostics.paths.length > 0) {
    parts.push('[Diagnostic paths] ' + bundle.diagnostics.paths.length + ' path(s)')
  }
  parts.push('[Question]')
  parts.push(current?.content ?? '')
  parts.push('[Answer requirements]')
  parts.push(EN_PROMPTS.answerFormat)
  return [
    { role: 'system', content: EN_PROMPTS.grounded },
    ...kept,
    { role: 'user', content: parts.join('\n') },
  ] as { role: 'system' | 'user' | 'assistant'; content: string }[]
}

export function buildPlainMessagesEn(
  history: { role: 'user' | 'assistant'; content: string }[],
  opts: { historyTurns: number; historyCharLimit: number },
): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  return [{ role: 'system', content: EN_PROMPTS.system }, ...hist(history, opts)] as { role: 'system' | 'user' | 'assistant'; content: string }[]
}
