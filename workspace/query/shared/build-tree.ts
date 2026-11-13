/**
 * 诊断树「先查哪个」· **方案 D · 融合阶梯** —— 纯函数层（零 React / 零 d3 / 零 IO）
 *
 * 2026-10-11 由 `frontend/src/components/TurnFigures.tsx` **原样迁出**（施工单《15-》§4.10），两个目的：
 *   ① **界面与问答档案（H5）共用同一份树逻辑** —— 档案里画的树与用户当时在界面上看到的一致；
 *   ② 新增 **问题画像（正则判型）→ 展开策略**：不同问法用不同的关系/类型优先级展开。
 *      🔴 **树的画法（从左往右、层距自适应）完全不动**，只改「哪些节点进树、按什么顺序」。
 *
 * 六步（《15-》§3.3）：① 尺子闸门 ② 问题锚点做根 ③ 因果主干按现象分组 ④ 措施三层
 * ⑤ 结构补层 ⑥ 三条不画。零契约改动：输入只有 EvidenceBundle，不改 shared/types.ts。
 */
import type { DiagnosticPath, EvidenceBundle } from './types'

export interface TNode { name: string; type: string; score?: string; rel?: string; kids: TNode[] }

/** 问题画像：fault 故障/原因（默认，**行为与原版逐字一致**）｜maint 保养/维护｜oper 操作/测量 */
export type TreeProfile = 'fault' | 'maint' | 'oper'

// ---------------------------------------------------------------------------
// 问题画像：**只看问题文本的正则**（不调模型、不动检索；命中顺序 fault → maint → oper）
//   · 先判 fault：避免「…是什么原因，怎么处理？」因「怎么」被误判成操作类；
//   · 未命中任一条 = fault（与原版一致）。
// ---------------------------------------------------------------------------
const FAULT_RE = /(故障|异常|失效|损坏|烧坏|烧毁|烧断|跳闸|报警|短路|断路|漏电|为什么|为啥|原因|排查|处理|修理|不正常|不动作|不能|不起|不转|不发电|不吸合|不释放|没有|无法|过低|过高|过大|过小|过载|异响|抖动)/
const MAINT_RE = /(保养|维护|检修|巡检|润滑|清洁|更换|定期|定保|大修|小修|保养项目|维护项目|维护保养|保养周期|寿命|预防性)/
const OPER_RE = /(怎么|如何|怎样|步骤|流程|方法|测量|测试|读数|接线|操作|使用|校准|标定|设定|调整|判断)/

export function classifyQuestion(question: string): TreeProfile {
  const q = question || ''
  if (FAULT_RE.test(q)) return 'fault'
  if (MAINT_RE.test(q)) return 'maint'
  if (OPER_RE.test(q)) return 'oper'
  return 'fault'
}

interface ProfileCfg {
  /** 锚点类型先验（问谁先画谁） */
  typePrior: string[]
  /** 结构层边关系优先级（小 → 大；未列出的 = 9） */
  relRank: Record<string, number>
  /** 结构层展开时**优先选中**的邻居类型（排在同层最前） */
  preferTypes: string[]
  /** 「现象级措施」允许的关系（fault 只认「对应」，与原版一致） */
  measureRels: string[]
}

/** fault 的关系优先级 = 原版 REL_RANK，**一字未改**（保证故障类树零变化） */
const FAULT_RANK: Record<string, number> = {
  导致: 0, 对应: 0, 发生: 0, 包含: 1, 属于: 1, 使用: 1, 适用: 1, 需注意: 2, 前置: 2, 可预防: 2,
}

export const PROFILES: Record<TreeProfile, ProfileCfg> = {
  fault: {
    typePrior: ['故障现象', '船舶装备', '零部件', '故障原因', '维修步骤'],
    relRank: FAULT_RANK,
    preferTypes: [],
    measureRels: ['对应'],
  },
  // 保养 / 维护类：先「该适用什么维护项目 / 要注意什么 / 有什么流程」，最后才是设备构成
  maint: {
    typePrior: ['船舶装备', '零部件', '维护项目', '故障现象', '维修步骤'],
    relRank: { 适用: 0, 前置: 0, 需注意: 0, 可预防: 0, 使用: 0, 对应: 1, 导致: 1, 发生: 1, 包含: 2, 属于: 2 },
    preferTypes: ['维护项目', '维修步骤', '注意事项'],
    measureRels: ['对应', '需注意', '前置', '可预防'],
  },
  // 操作 / 测量类：先步骤与用具（怎么做），再构成
  oper: {
    typePrior: ['船舶装备', '零部件', '维修步骤', '故障现象', '维护项目'],
    relRank: { 使用: 0, 前置: 0, 适用: 0, 需注意: 0, 对应: 1, 导致: 1, 发生: 1, 可预防: 1, 包含: 2, 属于: 2 },
    preferTypes: ['维修步骤', '维护项目', '注意事项', '零部件'],
    measureRels: ['对应', '使用', '前置', '需注意'],
  },
}

const rankOf = (cfg: ProfileCfg, rel: string): number => (cfg.relRank[rel] === undefined ? 9 : cfg.relRank[rel])
const preferOf = (cfg: ProfileCfg, type: string): number => (cfg.preferTypes.indexOf(type) >= 0 ? 0 : 1)

// ---------------------------------------------------------------------------
// 树的遍历与计数
// ---------------------------------------------------------------------------
function treeWalk(root: TNode | null, fn: (n: TNode, d: number) => void): void {
  if (!root) return
  const rec = (n: TNode, d: number): void => { fn(n, d); (n.kids || []).forEach((k) => rec(k, d + 1)) }
  rec(root, 1)
}

export function treeLeafCount(root: TNode | null): number {
  let n = 0
  treeWalk(root, (x) => { if (!x.kids || !x.kids.length) n += 1 })
  return n
}

export function treeNodeCount(root: TNode | null): number {
  let n = 0
  treeWalk(root, () => { n += 1 })
  return n
}

export function treeDepth(root: TNode | null): number {
  let max = 0
  treeWalk(root, (_x, d) => { if (d > max) max = d })
  return max
}

// ---------------------------------------------------------------------------
// ② 问题锚点：三级回退（+ 维护/操作画像的「点谁画谁」），保证根与问题相关
// ---------------------------------------------------------------------------
export function pickAnchor(
  bundle: EvidenceBundle,
  profile: TreeProfile = 'fault',
  cfg: ProfileCfg = PROFILES.fault,
): { name: string; type: string } | null {
  const q = bundle.question
  const nodes = bundle.graph.nodes
  const seeds = bundle.graph.seeds
  const links = bundle.graph.links
  if (!nodes.length) return null
  const subNames = new Set(nodes.map((n) => n.name))
  const deg = (name: string): number => links.filter((l) => l.fromName === name || l.toName === name).length
  const seedOf = (name: string) => seeds.find((s) => s.name === name)
  const semOf = (s?: { score: number; from?: { semantic?: number } }): number =>
    s && s.from && s.from.semantic !== undefined ? s.from.semantic : (s ? s.score : 0)
  const rank = (a: { type: string }, b: { type: string }): number => {
    const ia = cfg.typePrior.indexOf(a.type), ib = cfg.typePrior.indexOf(b.type)
    return (ia < 0 ? 9 : ia) - (ib < 0 ? 9 : ib)
  }
  const norm = (name: string, type: string, s?: { score: number; from?: { semantic?: number } }): { name: string; type: string; sem: number } =>
    ({ name: name, type: type, sem: s ? semOf(s) : 0 })
  // a) 问题文本直接出现、且在子图里（种子）
  const hit = seeds.find((s) => s.name.length >= 3 && q.indexOf(s.name) >= 0 && subNames.has(s.name))
  let anchor = hit ? norm(hit.name, hit.type, hit) : null
  if (!anchor || deg(anchor.name) === 0) {
    // a2) 🔴 仅维护/操作画像：问题里**点名的子图节点**（度 > 0）优先 —— 问谁就画谁
    //     （故障类不启用，保证 A 类树与原版逐字节一致；度 = 0 的节点救不活一棵树，跳过）
    if (profile !== 'fault') {
      const named = nodes.filter((n) => n.name.length >= 3 && q.indexOf(n.name) >= 0 && deg(n.name) > 0)
      if (named.length) {
        const best = named
          .slice()
          .sort((x, y) => rank(x, y) || (semOf(seedOf(y.name)) - semOf(seedOf(x.name))))[0]
        const a2 = norm(best.name, best.type, seedOf(best.name))
        return { name: a2.name, type: a2.type }
      }
    }
    // b) 子图节点 ∩ 候选 → 类型先验 → 语义分；**优先挑有邻接边的**（否则画出来是单节点）
    const cand = nodes.map((n) => norm(n.name, n.type, seedOf(n.name)))
    const pool = cand.filter((s) => cfg.typePrior.indexOf(s.type) >= 0)
    const ranked = (pool.length ? pool : cand).slice().sort((x, y) => rank(x, y) || y.sem - x.sem)
    const withEdge = ranked.find((s) => deg(s.name) > 0)
    // c) 还不行 → 子图里度最高的节点（Q4「船用变压器」就是这样救回 3 层的）
    const byDeg = nodes.slice().sort((m, n) => deg(n.name) - deg(m.name))[0]
    anchor = withEdge || (byDeg && deg(byDeg.name) > 0 ? norm(byDeg.name, byDeg.type) : ranked[0]) || anchor
  }
  return anchor ? { name: anchor.name, type: anchor.type } : null
}

// ---------------------------------------------------------------------------
// ④b 现象级措施：只认子图里**真实存在**的「现象 --关系--> 措施」
//     fault = 只认「对应」（原版）；maint / oper 另放行 需注意 / 前置 / 使用 等
// ---------------------------------------------------------------------------
export function measuresFromLinks(
  bundle: EvidenceBundle,
  phName: string,
  cfg: ProfileCfg = PROFILES.fault,
): { name: string; type: string }[] {
  const typeOf = (name: string): string => {
    const n = bundle.graph.nodes.find((x) => x.name === name)
    if (n) return n.type
    const s = bundle.graph.seeds.find((x) => x.name === name)
    return s ? s.type : ''
  }
  const out: { name: string; type: string }[] = []
  for (const l of bundle.graph.links) {
    if (cfg.measureRels.indexOf(l.relation) >= 0 && l.fromName === phName && !out.some((o) => o.name === l.toName)) {
      out.push({ name: l.toName, type: typeOf(l.toName) })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// ⑤ 结构补层：只走子图真三元组，visited 复用 occupied（根与因果层全排除）
//     🔴 排序 = 问题画像：**优先类型**（维护项目/维修步骤/注意事项…）→ 关系优先级 → 原顺序
// ---------------------------------------------------------------------------
function walkStructural(
  node: TNode,
  links: EvidenceBundle['graph']['links'],
  occupied: Set<string>,
  depth: number,
  typeOf: (n: string) => string,
  cfg: ProfileCfg,
): void {
  if (depth >= 3) return
  // 🔴 平行边去重：同一对节点间可能有多条关系（如 包含+适用），否则同一个 nb 会在候选里出现两次 → 树上重复
  const sorted = links
    .filter((l) => l.fromName === node.name || l.toName === node.name)
    .map((l, i) => ({ nb: l.fromName === node.name ? l.toName : l.fromName, rel: l.relation, i: i }))
    .filter((x) => !occupied.has(x.nb))
    .sort((x, y) =>
      (preferOf(cfg, typeOf(x.nb)) - preferOf(cfg, typeOf(y.nb))) ||
      (rankOf(cfg, x.rel) - rankOf(cfg, y.rel)) ||
      (x.i - y.i))
  const cand: { nb: string; rel: string }[] = []
  const seen = new Set<string>()
  for (const x of sorted) {
    if (seen.has(x.nb)) continue          // ① 同一目标只留优先级最高的一条边
    seen.add(x.nb)
    cand.push(x)                          // 不在候选阶段截断（见下：按**真正挂上的**数量 ≤4 截断）
  }
  // 🔴 2026-10-11 修潜在重复：兄弟递归可能已经把某个候选挂走（occupied 变化），
  //    原版先按候选截断 4 个再挂 → ① 白占一个名额 ② 同一节点在两处 push（靠 pruneDuplicates 事后补救）。
  //    现在：**先查 occupied 再挂**，按真正挂上的孩子数 ≤4 截断。
  let attached = 0
  for (const x of cand) {
    if (occupied.has(x.nb)) continue
    occupied.add(x.nb)
    const c: TNode = { name: x.nb, type: typeOf(x.nb), rel: x.rel, kids: [] }
    node.kids.push(c)
    walkStructural(c, links, occupied, depth + 1, typeOf, cfg)
    attached += 1
    if (attached >= 4) break
  }
}

/** ⑤' 全树去重：深度优先，同名节点只保留最先遇到（更浅）的那个，深处整枝丢弃 */
function pruneDuplicates(root: TNode): void {
  const seen = new Set<string>([root.name])
  const walk = (n: TNode): void => {
    const keep: TNode[] = []
    for (const k of n.kids || []) {
      if (seen.has(k.name)) continue      // 同名已出现过 → 丢掉这一枝
      seen.add(k.name)
      walk(k)
      keep.push(k)
    }
    n.kids = keep
  }
  walk(root)
}

/**
 * 方案 D 主入口：**整棵树由 bundle 现有数据拼出**（问句画像 → 展开策略）。
 * 返回 null = 不画（尺子闸门 / 素材空 / 单节点），调用方按「画不出来就不显示」处理。
 */
export function buildTree(bundle: EvidenceBundle): TNode | null {
  // ① 尺子闸门：证据不足 → 不出树（挡「1+1 等于多少」这类漫无目的）
  if (bundle.evidenceLevel === 'insufficient') return null
  const profile = classifyQuestion(bundle.question)
  const cfg = PROFILES[profile]
  const paths = bundle.diagnostics.paths
  const links = bundle.graph.links
  if (!paths.length && !links.length) return null
  const anchor = pickAnchor(bundle, profile, cfg)
  if (!anchor) return null
  const typeOf = (name: string): string => {
    const n = bundle.graph.nodes.find((x) => x.name === name)
    if (n) return n.type
    const s = bundle.graph.seeds.find((x) => x.name === name)
    return s ? s.type : ''
  }
  const relBetween = (a: string, b: string): string => {
    const l = links.find((x) => (x.fromName === a && x.toName === b) || (x.fromName === b && x.toName === a))
    return l ? l.relation : ''
  }
  const root: TNode = { name: anchor.name, type: anchor.type || '故障现象', kids: [] }
  const occupied = new Set<string>([root.name])      // ① 根先占位，杜绝根被重复挂
  const phAttached = new Set<string>()               // ③ 每个现象只挂一轮现象级措施

  // ③ 因果主干：诊断路径按 phenomenon 分组（修跨现象混挂）
  const groups = new Map<string, DiagnosticPath[]>()
  for (const p of paths) {
    const ph = p.phenomenon ? p.phenomenon.name : '（未识别现象）'
    if (!groups.has(ph)) groups.set(ph, [])
    groups.get(ph)!.push(p)
  }
  const isPhen = anchor.type === '故障现象'
  groups.forEach((ps, ph) => {
    let parent = root
    if (!(isPhen && ph === root.name)) {
      if (occupied.has(ph)) return
      occupied.add(ph)
      parent = { name: ph, type: '故障现象', rel: isPhen ? undefined : (relBetween(root.name, ph) || '命中'), kids: [] }
      root.kids.push(parent)
    }
    for (const p of ps) {
      const cname = p.cause ? p.cause.name : '（未识别原因）'
      if (occupied.has(cname)) continue             // ① 根或已画过的不再挂
      occupied.add(cname)
      const c: TNode = { name: cname, type: p.cause ? p.cause.type : '故障原因', score: p.score ? p.score.toFixed(3) : undefined, kids: [] }
      parent.kids.push(c)
      // ④ 措施：a) 真配对（后端给的 p.measures）b) 现象级（子图真边，每现象一轮）
      if (p.measures && p.measures.length && !p.pairMissing) {
        for (const m of p.measures.slice(0, 3)) {
          if (occupied.has(m.name) || m.name === cname) continue
          occupied.add(m.name)
          c.kids.push({ name: m.name, type: m.type, rel: '对应', kids: [] })
        }
      } else if (!phAttached.has(ph)) {
        phAttached.add(ph)
        for (const m of measuresFromLinks(bundle, ph, cfg).slice(0, 3)) {
          if (occupied.has(m.name)) continue
          occupied.add(m.name)
          c.kids.push({ name: m.name, type: m.type, rel: '现象级', kids: [] })
        }
      }
    }
  })

  // ⑤ 结构补层（深度不足才补）
  if (treeDepth(root) < 3) walkStructural(root, links, occupied, 0, typeOf, cfg)
  // ⑤' 全树去重兜底：同名只保留**更浅**的那一处，深处的整枝丢弃
  pruneDuplicates(root)
  // ⑥ 节点 ≤1 不画
  return treeNodeCount(root) > 1 ? root : null
}
