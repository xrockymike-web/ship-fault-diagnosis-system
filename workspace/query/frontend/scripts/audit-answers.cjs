#!/usr/bin/env node
/**
 * 回答质量巡检 —— **「回答风格与引用纪律」的回归工具**（2026-10-11 固化自 temp/audit-answers.cjs；施工单《交接/16-》§8）
 *
 * 用法：
 *   node scripts/audit-answers.cjs                          # 全量巡检，打印汇总表
 *   node scripts/audit-answers.cjs --days 1                 # 只看最近 1 天
 *   node scripts/audit-answers.cjs --label prompt-a --save # 落盘 data/runtime/audit/prompt-a.{json,md}
 *   node scripts/audit-answers.cjs --compare <旧报告.json>   # 与旧报告逐项对比（改提示词前后各跑一次即可）
 *
 * 口径（全部可复算；来源 = 每轮问答档案 data/runtime/qa-log/<日期>/<轮次>.html）：
 *   · 假引用       答案里的 [n] 在【本轮证据包 citations】里不存在（0 = 模型从不编编号）
 *   · 句子级命中率 带 [n] 的句子 / 全部句子（按 。！？ 切分，>4 字）
 *   · 回答级命中率 至少带 1 个 [n] 的回答 / 全部回答（含拒答）
 *   · copy12      答案 12 字滑窗中能在本轮提示词原文里找到的比例（越高越像照抄）
 *   · 来源泄漏     答案里出现**来源定位痕迹**：块编号（v1.2 后资料里唯一可见的标识符，
 *                 规则 6 要压的目标）、页码「第 N 页」、书名《…》、「（证据：…）」。
 *                 ⚠️ v1.2 起证据包已无章节/页码字段，块编号是主要泄漏源。
 *                 （2026-10-16 换轨：旧口径「抄文献名率」只测《…》与页码，提示词里这些已不存在 → 会静默恒为 0）
 *   · 拒答        答案含「资料不足 / 无法判断」（库外问题被闸门拦下的正常表现）
 *   · 降级轮      本轮有检索路 state != ok（失败/超时，报告里不静默）
 *
 * 纪律：**只读** qa-log；只写 data/runtime/audit/（运行时目录，不入 git）。不依赖任何三方包。
 */
const fs = require('node:fs')
const path = require('node:path')

const HERE = __dirname
const QUERY = path.join(HERE, '..', '..')            // workspace/query
const DATA = path.join(QUERY, '..', 'data')          // workspace/data
const QA = path.join(DATA, 'runtime', 'qa-log')
const OUT = path.join(DATA, 'runtime', 'audit')

const argv = process.argv.slice(2)
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt }
const has = (name) => argv.includes(name)
const days = Number(arg("--days", 0)) || 0
const label = arg("--label", "")
const comparePath = arg("--compare", "")
const save = has("--save") || !!label

const un = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, String.fromCharCode(39)).replace(/&amp;/g, '&')
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0)

/** 读一份档案 → 一轮的记录（缺块则尽量降级，不抛） */
function readTurn(file) {
  const h = fs.readFileSync(file, 'utf8')
  const rawM = h.match(/<script type="application\/json" id="raw-turn">([\s\S]*?)<\/script>/)
  // 🔴 2026-10-11 修正：raw-turn 是**外层包装**，证据包在 `evidenceBundle`；答案与七段提示词也在包装里
  //    （raw.answer / raw.prompt.user）——直接取比解析 HTML 更准。此前误把包装当 bundle → citations 读不到。
  let raw = null
  try { raw = JSON.parse(un(rawM[1])) } catch { raw = null }
  const b = raw && raw.evidenceBundle ? raw.evidenceBundle : null
  const q = h.match(/<p class="q">([^<]*)<\/p>/)
  const question = raw && raw.question ? raw.question : (q ? un(q[1]) : '')
  const i12 = h.indexOf('⑫')
  const am = (i12 >= 0 ? h.slice(i12, i12 + 12000) : '').match(/<pre>([\s\S]*?)<\/pre>/)
  const ans = raw && typeof raw.answer === 'string' ? raw.answer : (am ? un(am[1]) : '')
  const promptUser = raw && raw.prompt && raw.prompt.user ? raw.prompt.user : ''
  const ansN = ans.replace(/\[n\s*[:：]\s*(\d+)\]/g, '[$1]')
  const ids = [...new Set((ansN.match(/\[(\d{1,3})\]/g) || []).map((x) => x.replace(/\D/g, "")))]
  const valid = b && Array.isArray(b.citations) ? new Set(b.citations.map((c) => String(c.no ?? c.id ?? c.index ?? ""))) : new Set()
  const invalid = valid.size ? ids.filter((x) => !valid.has(x)) : []
  const sents = ansN.split(/[。！？]\s*/).filter((s) => s.trim().length > 4)
  const cites = (ansN.match(/\[\d{1,3}\]/g) || []).length
  const citedSent = sents.filter((s) => /\[\d{1,3}\]/.test(s)).length
  const norm = (s) => s.replace(/\s+/g, "")
  const e = norm(promptUser).slice(0, 20000)
  const sh = new Set()
  for (let k = 0; k + 12 <= e.length; k += 1) sh.add(e.slice(k, k + 12))
  const a = norm(ans)
  let hit = 0, tot = 0
  for (let k = 0; k + 12 <= a.length; k += 1) { tot += 1; if (sh.has(a.slice(k, k + 12))) hit += 1 }
  const failed = b && b.status ? Object.keys(b.status).filter((k) => b.status[k].state !== "ok") : []
  return {
    file: path.basename(file),
    day: path.basename(path.dirname(file)),
    q: question.slice(0, 18),
    chars: ans.length,
    cites, invalid: invalid.length,
    sents: sents.length, citedSent,
    copy12: tot ? +(hit / tot).toFixed(3) : 0,
    // 🔴 v1.2 换轨：块编号成为资料里唯一可见的标识符 → 它才是"引用纪律规则 6"现在要压的目标。
    //    旧口径（只测《…》与页码）在 v1.2 后结构性恒为 0，会静默失真、被误读为"改好了"。
    meta: (/(?:块\s*)?(?:TXT|PRT|TBL|UT|UR|E|T|U)-\d{3,4}|(^|[^\w\-])(?:ch|pa|tb)-\d{2}-\d{2}|《[^》]{4,}》|第\s*\d+\s*[–-]\s*\d+\s*页|证据[:：]/.test(ans)) ? 1 : 0,
    insuff: /资料不足|无法判断|资料未说明/.test(ans) ? 1 : 0,
    level: b ? b.evidenceLevel : '?',
    nodes: b && b.graph ? b.graph.nodes.length : 0,
    paths: b && b.graph && b.graph.causalPaths ? b.graph.causalPaths.length : 0,
    degraded: failed.length,
  }
}

function scan() {
  if (!fs.existsSync(QA)) { console.error("找不到 qa-log：" + QA); process.exit(1) }
  let dirs = fs.readdirSync(QA).filter((d) => fs.statSync(path.join(QA, d)).isDirectory()).sort()
  if (days > 0) dirs = dirs.slice(-days)
  const turns = []
  for (const d of dirs) {
    const dd = path.join(QA, d)
    for (const f of fs.readdirSync(dd).filter((x) => x.endsWith(".html")).sort()) {
      try { turns.push(readTurn(path.join(dd, f))) } catch (e) { console.error("跳过 " + f + "：" + e.message) }
    }
  }
  return turns
}

const agg = (list) => {
  const n = list.length
  const s = (k) => list.reduce((a, x) => a + x[k], 0)
  const sents = s("sents"), cited = s("citedSent")
  return {
    n,
    answerLevel: pct(list.filter((x) => x.cites > 0).length, n),
    sentenceLevel: pct(cited, sents),
    citesTotal: s("cites"),
    fakeCites: s("invalid"),
    avgChars: n ? Math.round(s("chars") / n) : 0,
    copy12Avg: n ? +(s("copy12") / n).toFixed(3) : 0,
    metaRate: pct(s("meta"), n),
    insuffRate: pct(s("insuff"), n),
    degradedTurns: s("degraded"),
  }
}

const turns = scan()
if (!turns.length) { console.error("没有可巡检的档案"); process.exit(1) }
const overall = agg(turns)
const byDay = {}
for (const t of turns) { (byDay[t.day] = byDay[t.day] || []).push(t) }

const F = (r) => [r.n, r.answerLevel + "%", r.sentenceLevel + "%", r.citesTotal, r.fakeCites, r.avgChars, r.copy12Avg, r.metaRate + "%", r.insuffRate + "%", r.degradedTurns].join(" | ")
console.log("回答质量巡检 ｜ " + turns.length + " 轮" + (label ? " ｜ 标签 " + label : ""))
console.log("日期       | n  | 回答级 | 句子级 | 引用数 | 假引用 | 均长 | copy12 | 来源泄漏 | 拒答 | 降级")
console.log("---------- | -- | ------ | ------ | ------ | ------ | ---- | ------ | -------- | ---- | ----")
for (const d of Object.keys(byDay).sort()) console.log(d + " | " + F(agg(byDay[d])))
console.log("合计       | " + F(overall))

if (comparePath) {
  const old = JSON.parse(fs.readFileSync(comparePath, "utf8")).overall
  const d = (a, b) => (b - a >= 0 ? "+" : "") + (b - a)
  console.log("")
  console.log("与 " + path.basename(comparePath) + " 对比：")
  console.log("  回答级命中率  " + old.answerLevel + "% → " + overall.answerLevel + "%  (" + d(old.answerLevel, overall.answerLevel) + ")")
  console.log("  句子级命中率  " + old.sentenceLevel + "% → " + overall.sentenceLevel + "%  (" + d(old.sentenceLevel, overall.sentenceLevel) + ")")
  console.log("  假引用        " + old.fakeCites + " → " + overall.fakeCites + "  (" + d(old.fakeCites, overall.fakeCites) + ")")
  console.log("  平均长度      " + old.avgChars + " → " + overall.avgChars + "  (" + d(old.avgChars, overall.avgChars) + ")")
  console.log("  copy12        " + old.copy12Avg + " → " + overall.copy12Avg + "  (" + d(old.copy12Avg, overall.copy12Avg) + ")")
  console.log("  来源泄漏率    " + old.metaRate + "% → " + overall.metaRate + "%  (" + d(old.metaRate, overall.metaRate) + ")")
}

if (save) {
  fs.mkdirSync(OUT, { recursive: true })
  const name = label || ("audit-" + new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-"))
  const jsonPath = path.join(OUT, name + ".json")
  fs.writeFileSync(jsonPath, JSON.stringify({ label: name, at: new Date().toISOString(), overall, byDay: Object.fromEntries(Object.keys(byDay).sort().map((d) => [d, agg(byDay[d])])), turns }, null, 1), "utf8")
  const md = ["# 回答质量巡检 ｜ " + name, "", "> " + new Date().toLocaleString("zh-CN") + " ｜ " + turns.length + " 轮 ｜ 工具 scripts/audit-answers.cjs", "", "## 合计", "", "| n | 回答级命中率 | 句子级命中率 | 引用数 | 假引用 | 平均长度 | copy12 | 来源泄漏率 | 拒答率 | 降级轮 |", "|---|---|---|---|---|---|---|---|---|---|", "| " + F(overall).replace(/ \| /g, " | ") + " |", "", "## 按日期", "", "| 日期 | n | 回答级 | 句子级 | 引用数 | 假引用 | 均长 | copy12 | 来源泄漏 | 拒答 | 降级 |", "|---|---|---|---|---|---|---|---|---|---|---|"]
  for (const d of Object.keys(byDay).sort()) md.push("| " + d + " | " + F(agg(byDay[d])).replace(/ \| /g, " | ") + " |")
  md.push("", "## 逐轮", "", "| 档案 | 问题 | 字数 | 引用 | 假引用 | 句 | 带引 | copy12 | 来源泄漏 | 拒答 | 档位 | 节点 | 通路 | 降级 |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
  for (const t of turns) md.push("| " + [t.file, t.q, t.chars, t.cites, t.invalid, t.sents, t.citedSent, t.copy12, t.meta, t.insuff, t.level, t.nodes, t.paths, t.degraded].join(" | ") + " |")
  fs.writeFileSync(path.join(OUT, name + ".md"), md.join("\n"), "utf8")
  console.log("")
  console.log("已落盘：" + jsonPath)
  console.log("已落盘：" + path.join(OUT, name + ".md"))
}
