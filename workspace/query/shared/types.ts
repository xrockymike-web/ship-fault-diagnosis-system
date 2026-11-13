/**
 * 前后端共用类型契约（目标 4 · 4.5）。
 *
 * 🔴 本文件是 **EvidenceBundle 的唯一冻结点**（《技术总纲》决策 D24 · A9；
 *    《开发顺序》§6.2「EvidenceBundle 结构冻结（前后端共用类型 shared/types.ts）」）。
 *
 * 四块结构（A9 定案；2026-10-19 起 五块 → 四块）：
 *   ① 登记信息（版本 / 原问题 / **每一路的成功·失败·超时与原因**）
 *   ② 原文证据（文本路 3 条，只带块编号 `chunkId`）
 *   ③ 图谱（种子实体 + 局部子图 + 两类路径 + no_path）
 *   ④ 诊断路径（带分数的排序链；配对缺失标 `pairMissing`）
 *
 * 三条纪律（写进类型而不是写进注释就算）：
 *   1. **不装提示词** —— 提示词是 evidence-prompt 的产物，混进来以后改提示词就要动契约；
 *   2. **两路分数各自带，但不可互相比较** —— 字段名带路名（`score` 只在各自块内），
 *      §5.5 明文「不做分数归一化 / 不做加权融合」；
 *   3. **[编号] 在包内排好**（\`citations\`）—— 模型看到的 [3] 必须与界面显示的 [3] 是同一个。
 *
 * 版本：改结构 = 升 \`bundleVersion\`，不推翻。
 */
/** 🔴 改结构 = 升版本：`1.1`（U4）新增 `TextEvidence.kind === 'user'`（用户自建文本进证据）
 *  🔴 `1.2`（2026-10-16 **证据定位单轨化**）：删 `ChunkRef` 的
 *     `docTitle / chapter / section / pageStart / pageEnd / assetNo` 六个来源字段。
 *     定位**只用文本块编号**（`chunkId`，固定、可精准定位）；用户自建文本的标题与来源备注
 *     改用 `TextEvidence.title` / `TextEvidence.sourceNote` 承载，**不再借用来源字段**。
 *  🔴 `1.3`（2026-10-19）：`EvidenceBundle` 收为四块；共现边（`cooccurrencePaths`）保留，
 *     来源改为 graph 库。
 *     🔴 老证据包（≤1.2）里仍多两个字段 —— 读取方必须容忍缺失（界面已加守卫）。 */
export type BundleVersion = '1.0' | '1.1' | '1.2' | '1.3'

/** 两路 + 诊断路径（诊断路径是图路之后的独立一步，但状态与图路分开记） */
export type PathName = 'text' | 'graph' | 'diagnostics'
export type PathState = 'ok' | 'failed' | 'timeout' | 'skipped'

// ---------------------------------------------------------------------------
// 目标 5 · ① 知识图谱全貌页（决策 D27）——**只画关系图**（共现边不入图）
// ---------------------------------------------------------------------------

/**
 * 全貌页的一个实体（`degree` 由后端算：界面的标签按度数取、统计实时算）。
 * 🆕 U2：`origin` 区分来源 —— 教材（curated）还是用户自建（user）；
 * 界面据此画虚线环、并把「教材实体」与「自建实体」**分开计数**。
 */
export interface GraphOverviewEntity {
  entityId: string
  name: string
  type: string
  degree: number
  origin?: 'curated' | 'user'
}

/**
 * 全貌页的一条关系边（subject/object 都是 entityId；relation 是关系名）。
 * 🆕 U2：`origin` —— 教材边（curated）还是用户自建边（user）。
 */
export interface GraphOverviewTriple {
  subject: string
  object: string
  relation: string
  origin?: 'curated' | 'user'
}

/** `graph.overview` 的回包：**一次性拉全量**（1463 实体 / 1116 边，约 150–200 KB），前端内存缓存 */
export interface GraphOverview {
  entities: GraphOverviewEntity[]
  triples: GraphOverviewTriple[]
  /** 11 类关系名（供筛选下拉） */
  relationTypes: string[]
  /** 后端读库耗时（ms） */
  loadedMs: number
}

/** 一条证据的**可追溯坐标**：**只有文本块编号**（固定、可精准定位）。
 *  🔴 v1.2：来源元数据（文档名 / 章节 / 页码 / 表图号）已整体移除，
 *     定位与引用一律走块编号；不再有第二套坐标。 */
export interface ChunkRef {
  chunkId: string
}

/**
 * ② 原文证据（文本路的一条）。
 * `kind`：`parent` = 语料原文块（2026-10-22 起 `table` 已下线）；🆕 `user` = **用户自建文本**（U4/D29，
 * 有原文、可被引用，但**权威性低于语料**，引用卡片显示「用户录入」）。
 */
export interface TextEvidence extends ChunkRef {
  kind: 'parent' | 'user'
  text: string
  /** 命中的子块（用于高亮）：按名次升序 */
  matches: { chunkId: string; rank: number }[]
  /** **文本路路内**融合分（RRF）—— 不可与图路的分数比较（2026-10-19 起无软偏置放大） */
  score: number
  /** 🆕 v1.2：**用户自建文本**的标题（仅 `kind === 'user'` 有值；语料块无） */
  title?: string | null
  /** 🆕 v1.2：**用户自建文本**的来源备注（用户自填；仅 `kind === 'user'` 有值） */
  sourceNote?: string | null
}

/** ③-a 种子实体（实体链接结果） */
export interface GraphSeed {
  entityId: string
  name: string
  type: string
  evidenceChunkIds: string[]
  /** 怎么进来的（可追溯；命中置顶的是 `pattern`） */
  from: { semantic?: number; text?: number; pattern?: boolean }
  /** 图路**路内**分数（RRF） */
  score: number
}

export interface SubgraphNode {
  entityId: string
  name: string
  type: string
  /** 距最近种子的跳数（0 = 种子） */
  hop: number
}

export interface SubgraphLink {
  from: string
  fromName: string
  to: string
  toName: string
  /** 关系名（如 `导致` / `对应`）；共现边关系名固定为 `共现关联` */
  relation: string
  evidenceChunkIds: string[]
}

/** ③-b 路径：两级（**因果链** / **共现关联**）—— 共现边明确非因果（§4.3.3 纪律②） */
export type PathLevel = 'causal' | 'cooccurrence'

export interface GraphPath {
  level: PathLevel
  nodes: { entityId: string; name: string; type: string }[]
  edges: {
    relation: string
    from: string
    to: string
    evidenceChunkIds: string[]
  }[]
  /** 有向路径 / 无向兜底 */
  directed: boolean
}

/** ⑤ 诊断路径的一环 */
export interface DiagnosticEdge {
  relation: string
  from: string
  to: string
  /** 关系权重（配置项，标「未标定」） */
  weight: number
  /** 该边绑定文本与问题的相似度（块向量余弦取最大；无证据 = \`noEvidenceSimilarity\`） */
  similarity: number
  evidenceChunkIds: string[]
}

export interface DiagnosticPath {
  rank: number
  /** 分 = 边分平均 × lengthPenalty^(边数−1)（A6） */
  score: number
  phenomenon: { entityId: string; name: string; type: string } | null
  cause: { entityId: string; name: string; type: string } | null
  measures: { entityId: string; name: string; type: string }[]
  edges: DiagnosticEdge[]
  /** 原因→措施配对缺失：**并列展示、不强配**（§5.6.3 结论 3） */
  pairMissing: boolean
}

/** 引用编号（A9 第 3 条：包内排好，模型与界面共用一套） */
export interface CitationRef {
  no: number
  kind: 'chunk' | 'entity' | 'path'
  refId: string
}

export interface PathStatus {
  state: PathState
  ms: number
  /** 失败 / 超时**必须**写清原因（红线：不静默降级） */
  error?: string
}

/** 证据充足度三档（§2.4.4 / §5.4；阈值 = 文本路最像子块余弦，配置项标「未标定」） */
export type EvidenceLevel = 'sufficient' | 'partial' | 'insufficient'

/** 🔴 证据包（唯一契约） */
export interface EvidenceBundle {
  bundleVersion: string
  question: string
  createdAt: number
  /** ① 登记信息：**每一路**的状态、耗时、失败原因 */
  status: Record<PathName, PathStatus>
  /** ② 原文证据（文本路 3 条） */
  text: { evidences: TextEvidence[] }
  /** ③ 图谱 */
  graph: {
    seeds: GraphSeed[]
    nodes: SubgraphNode[]
    links: SubgraphLink[]
    causalPaths: GraphPath[]
    cooccurrencePaths: GraphPath[]
    /** 找不到路径就标 true —— **不硬造**（§4.3.3 第 5 步） */
    noPath: boolean
  }
  /** ④ 诊断路径 */
  diagnostics: { paths: DiagnosticPath[] }
  /** 引用映射（包内排好） */
  citations: CitationRef[]
  /** 证据充足度（供 §2.4.4 三档行为） */
  evidenceLevel: EvidenceLevel
  /** 判据用的「最高相似度」= 文本路最像子块余弦 */
  highestSimilarity: number | null
  /** 过程备注（偏置命中数、截断、配对缺失数…）；**任何降级都要在这里留痕** */
  notes: string[]
}

// ---------------------------------------------------------------------------
// 用户知识库（User KB）—— 负责人 2026-10-07 追加功能组块（U1）
//
// 🔴 落点唯一：`<dataDir>/user_data/`（开发态 `workspace/data/user_data`）。
//    这一节是**纯追加**：不改 EvidenceBundle 四块、不动两库与 curated。
//    本文件仍保持**只有类型、没有运行时值**（shared/ 不产运行时文件）。
// ---------------------------------------------------------------------------

/** 用户录入文本（一段一条；**有原文** → 可被引用，引用卡片标「用户录入」） */
export interface UserText {
  id: string
  title: string
  text: string
  /** 来源备注（用户自填：出自哪本书/哪次检修…）；可空 */
  sourceNote: string | null
  createdAt: number
  /** 🆕 U3：是否已有向量（没有 = 「待索引」，检索里暂时查不到） */
  indexed?: boolean
}

/** 用户新增图节点（类型限本体 7 类） */
export interface UserEntity {
  id: string
  name: string
  type: string
  aliases: string[]
  description: string | null
  createdAt: number
  /** 🆕 U3：是否已有向量（实体向量用于"路B 语义召回"） */
  indexed?: boolean
}

/** 用户新增三元组（关系限本体 11 类；两端必须存在 = 用户实体 或 教材实体） */
export interface UserTriple {
  id: string
  subjectId: string
  predicate: string
  objectId: string
  note: string | null
  createdAt: number
}

/** 一次拉全量（自建量级小，与 graph.overview 同策略）+ 本体清单（避免前端硬编码第二份） */
export interface UserKbSnapshot {
  texts: UserText[]
  entities: UserEntity[]
  triples: UserTriple[]
  /** 本体 7 类实体（后端给，前端不硬编码） */
  entityTypes: string[]
  /** 本体 11 类关系（后端从 graph 库只读读取） */
  relationTypes: string[]
  /** 每次写入 +1；用于缓存失效与"前端是否要刷新" */
  revision: number
  /** 🆕 U3：还没有向量的条数（界面据此提示「重建索引」） */
  pendingIndex?: number
}

/** 保存回执：warnings = "不阻断但必须显示"的提示（如与教材实体同名、级联删了几条边） */
export interface UserKbSaveResult {
  revision: number
  warnings: string[]
  /** 新建时回传生成的 id（编辑时为原 id） */
  id: string
}

/** 删除回执：级联删除的条数要如实回传（不静默） */
export interface UserKbDeleteResult {
  revision: number
  removed: number
  warnings: string[]
}

