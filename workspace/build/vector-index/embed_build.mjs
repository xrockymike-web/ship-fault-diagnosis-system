#!/usr/bin/env node
/**
 * 4.1 统一向量批量编码 —— 三类（块 / 实体 / 三元组）
 * 依据：交接/4.1-统一向量施工单-10061034.md + 《技术总纲》决策 D23
 * 用法：
 *   node workspace/build/vector-index/embed_build.mjs [--backend cuda|cpu] [--only chunk,entity,triple] [--limit N]
 * 产出（中间向量，不进 git）：
 *   build/vector-index/chunk/vector/chunk.jsonl
 *   build/vector-index/graph/vector/entity.jsonl
 *   build/vector-index/graph/vector/triple.jsonl
 *   build/vector-index/params.json
 * 幂等：已存在的 obj_id 跳过（append，不覆盖）；同参数重跑 = 0 次真实编码
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
// ---------- args（2026-10-22：支持在 data 镜像内建库，不覆盖生产向量） ----------
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const DATA = path.resolve(arg("--data", path.join(ROOT, "workspace", "data")));
const OUTB = path.resolve(arg("--out", path.join(ROOT, "workspace", "build", "vector-index")));
const RESET = String(arg("--reset", "")).split(",").map(s => s.trim()).filter(Boolean);
const RUNTIME = path.join(DATA, "runtime", "4.1_embed");
const MODEL = path.join(ROOT, "workspace", "environment", "models", "embedding", "Qwen3-Embedding-0.6B-Q8_0.gguf");
const EXE = {
  cuda: path.join(ROOT, "workspace", "environment", "llamacpp", "cuda", "llama-server.exe"),
  cpu: path.join(ROOT, "workspace", "environment", "llamacpp", "cpu", "llama-server.exe"),
};
const MODEL_ID = "Qwen3-Embedding-0.6B-Q8_0";
const TEMPLATE = "p23-v1";
const MAX_CHARS = 1200;   // 施工单 T3-7：编码文本上限（字符数）
const CONCURRENCY = 8;    // 实测定：并发 8 最优，服务端参数不动
const BATCH = 32;
const TIMEOUT_MS = 120000;
const RETRIES = 3;
const PORT = 18321;

// ---------- args（续） ----------
const BACKEND = arg("--backend", "cuda");
// 🔴 2026-10-22：原第三类向量已随 10-19 的两库化一并删除——对应源数据不存在，
//    保留它只会让人以为还能跑。默认口径 = chunk,entity,triple。
const ONLY = (arg("--only", "chunk,entity,triple")).split(",").map(s => s.trim()).filter(Boolean);
const LIMIT = Number(arg("--limit", "0")) || 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = m => console.log(m);

// ---------- 文本工具 ----------
function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.length) continue;
    const out = []; let cur = ""; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += c; }
      else { if (c === '"') inQ = true; else if (c === ',') { out.push(cur); cur = ""; } else cur += c; }
    }
    out.push(cur); rows.push(out);
  }
  return rows;
}
const readJsonl = f => fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean).map(s => JSON.parse(s));
const sha256 = f => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex").slice(0, 16);

/** 附录 A §2.3 线性化的落地实现（算法见施工单 §3.2） */
export function linearizeTable(text) {
  const ls = String(text || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const isPipe = s => s.startsWith("|");
  const isDelim = s => /^\|[\s\-:|]+\|?\s*$/.test(s);
  const cells = s => s.replace(/^\|/, "").replace(/\|$/, "").split("|").map(x => x.trim());
  const plain = ls.filter(s => !isPipe(s));
  const pipes = ls.filter(s => isPipe(s) && !isDelim(s)).filter(s => !(cells(s).length === 1 && cells(s)[0].toLowerCase() === "hline"));
  const delimIdx = ls.findIndex(isDelim);
  let header = null, data = [];
  if (delimIdx >= 0) {
    const before = ls.map((s, i) => ({ s, i })).filter(o => o.i < delimIdx && isPipe(o.s) && !isDelim(o.s) && !(cells(o.s).length === 1 && cells(o.s)[0].toLowerCase() === "hline"));
    if (before.length) header = cells(before[before.length - 1].s);
    data = pipes.filter(s => ls.indexOf(s) > delimIdx);
  } else if (pipes.length) {
    header = cells(pipes[0]); data = pipes.slice(1);
  }
  const out = [];
  if (plain.length) out.push(plain[0]);
  for (const row of data) {
    const cs = cells(row);
    const parts = [];
    cs.forEach((v, i) => { if (!v) return; parts.push(header && header[i] ? header[i] + " " + v : v); });
    if (parts.length) out.push(parts.join(" "));
  }
  for (let i = 1; i < plain.length; i++) out.push(plain[i]);
  return out.length ? out.join("\n") : "";
}

function mk(obj_id, raw, ref) {
  const src_chars = raw.length;
  const truncated = src_chars > MAX_CHARS ? 1 : 0;
  return { obj_id, text: truncated ? raw.slice(0, MAX_CHARS) : raw, src_chars, truncated, ref };
}

// ---------- 四类文本（照 D23） ----------
export function itemsChunk() {
  const f = path.join(DATA, "chunk", "chunks_filled.jsonl");
  const out = [];
  for (const o of readJsonl(f)) {
    if (o.kind === "parent") continue;
    const body = o.kind === "table" ? linearizeTable(o.text) : (o.text || "");
    out.push(mk(o.id, (o.chapter || "") + "\n" + (o.section || "") + "\n" + body));
  }
  return { items: out, input: f };
}
export function itemsEntity() {
  const f = path.join(DATA, "graph", "entities.csv");
  const rows = parseCsv(fs.readFileSync(f, "utf8")); rows.shift();
  const out = [];
  for (const c of rows) {
    const name = c[1] || "", desc = c[3] || "", attrs = c[8] || "";
    const raw = attrs.trim() ? name + "\n" + attrs : (desc.trim() ? name + "\n" + desc : name);
    out.push(mk(c[0], raw));
  }
  return { items: out, input: f };
}
export function itemsTriple() {
  const f = path.join(DATA, "graph", "triples.csv");
  const rows = parseCsv(fs.readFileSync(f, "utf8")); rows.shift();
  const out = [];
  // 🔴 2026-10-22 修复：obj_id 必须是 triple_id（T-####）。此前用行号 "1".."1116"，
  //    与库里的 T-#### 不匹配 → 重新嵌入会产出 1,116 条孤儿向量（已实测）。
  rows.forEach((c) => {
    const tid = String(c[0] || "").trim();
    if (!tid) return;
    out.push(mk(tid, (c[1] || "") + " " + (c[4] || "") + " " + (c[7] || ""), (c[0] || "") + "|" + (c[3] || "") + "|" + (c[6] || "")));
  });
  return { items: out, input: f };
}
// ---------- 服务 ----------
function startServer() {
  fs.mkdirSync(RUNTIME, { recursive: true });
  const exe = fs.existsSync(EXE[BACKEND]) ? EXE[BACKEND] : EXE.cpu;
  const ngl = BACKEND === "cpu" || !fs.existsSync(EXE[BACKEND]) ? "0" : "99";
  const o = fs.openSync(path.join(RUNTIME, "server.out.log"), "a");
  const e = fs.openSync(path.join(RUNTIME, "server.err.log"), "a");
  const args = ["-m", MODEL, "-c", "2048", "-ngl", ngl, "--embedding", "--pooling", "last", "--embd-normalize", "2", "--host", "127.0.0.1", "--port", String(PORT)];
  log("start server: " + path.basename(exe) + " ngl=" + ngl + " port=" + PORT);
  const proc = spawn(exe, args, { stdio: ["ignore", o, e], windowsHide: true });
  return { proc, exe };
}
async function waitHealth(timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch("http://127.0.0.1:" + PORT + "/health"); if (r.ok) { const j = await r.json(); if (j.status === "ok") return Date.now() - t0; } } catch {}
    await sleep(500);
  }
  throw new Error("embedding server not healthy within " + timeoutMs + "ms");
}
async function embedBatch(texts) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch("http://127.0.0.1:" + PORT + "/v1/embeddings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: texts, encoding_format: "float" }), signal: ac.signal });
    if (!r.ok) throw new Error("HTTP " + r.status + " " + (await r.text()).slice(0, 160));
    const j = await r.json();
    const arr = j.data.map(d => d.embedding);
    if (arr.length !== texts.length) throw new Error("count mismatch " + arr.length + "/" + texts.length);
    return arr;
  } finally { clearTimeout(t); }
}
async function embedRetry(texts) {
  let last;
  for (let a = 0; a < RETRIES; a++) { try { return await embedBatch(texts); } catch (err) { last = err; await sleep(1000 * Math.pow(2, a)); } }
  throw last;
}

// ---------- 落盘 ----------
function doneIds(file) {
  const s = new Set();
  if (!fs.existsSync(file)) return s;
  for (const ln of fs.readFileSync(file, "utf8").split(/\r?\n/)) { if (!ln.trim()) continue; try { s.add(JSON.parse(ln).obj_id); } catch {} }
  return s;
}
function line(it, vec) {
  const o = { obj_id: it.obj_id, dim: vec.length, model_id: MODEL_ID, template_version: TEMPLATE, truncated: it.truncated, src_chars: it.src_chars, vec };
  if (it.ref) o.ref = it.ref;
  return JSON.stringify(o);
}
async function runClass(name, file, items) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 🔴 2026-10-22：--reset 先清空旧向量文件。块号沿用 TXT-####，增量跳过会用旧文本的向量顶替新块。
  if (RESET.includes(name)) { if (fs.existsSync(file)) { fs.rmSync(file); log("[" + name + "] reset: 已清空旧向量文件"); } }
  const done = doneIds(file);
  let todo = items.filter(it => !done.has(it.obj_id));
  if (LIMIT) todo = todo.slice(0, LIMIT);
  log("[" + name + "] total=" + items.length + " already=" + (items.length - todo.length) + " todo=" + todo.length);
  const failed = []; let ok = 0;
  const GROUP = CONCURRENCY * BATCH;
  for (let g = 0; g < todo.length; g += GROUP) {
    const group = todo.slice(g, g + GROUP);
    const res = new Array(group.length);
    const subs = []; for (let k = 0; k < group.length; k += BATCH) subs.push(k);
    let si = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (true) {
        const k = si++; if (k >= subs.length) return;
        const off = subs[k], sub = group.slice(off, off + BATCH);
        try { const vecs = await embedRetry(sub.map(x => x.text)); for (let j = 0; j < sub.length; j++) res[off + j] = line(sub[j], vecs[j]); }
        catch (err) { for (const x of sub) failed.push({ obj_id: x.obj_id, error: String(err && err.message || err) }); }
      }
    }));
    const lines = res.filter(Boolean);
    if (lines.length) fs.appendFileSync(file, lines.join("\n") + "\n");
    ok += lines.length;
    log("[" + name + "] " + Math.min(g + GROUP, todo.length) + "/" + todo.length);
  }
  // encoded = 本次新算的条数；present = 文件里现有向量条数（重建后两者应相等）
  const present = doneIds(file).size;
  return { name, total: items.length, encoded: ok, present, failed };
}

// ---------- main ----------
const CLASSES = {
  chunk: { file: path.join(OUTB, "chunk", "vector", "chunk.jsonl"), build: itemsChunk },
  entity: { file: path.join(OUTB, "graph", "vector", "entity.jsonl"), build: itemsEntity },
  triple: { file: path.join(OUTB, "graph", "vector", "triple.jsonl"), build: itemsTriple },
};

export { MODEL_ID, TEMPLATE, MAX_CHARS, CONCURRENCY, BATCH };

async function main() {
let server = null;
try {
  const t0 = Date.now();
  server = startServer();
  const h = await waitHealth();
  log("server ready in " + h + " ms");
  const report = { template_version: TEMPLATE, model_id: MODEL_ID, backend: BACKEND, concurrency: CONCURRENCY, batch: BATCH, max_chars: MAX_CHARS, classes: {}, inputs: {} };
  for (const name of ONLY) {
    const c = CLASSES[name]; if (!c) throw new Error("unknown class " + name);
    const { items, input } = c.build();
    report.inputs[name] = { file: path.relative(ROOT, input).replace(/\\/g, "/"), sha256_16: sha256(input), rows: items.length };
    report.classes[name] = await runClass(name, c.file, items);
  }
  report.elapsed_ms = Date.now() - t0;
  fs.writeFileSync(path.join(OUTB, "params.json"), JSON.stringify(report, null, 1));
  log("params.json written");
  const anyFail = Object.values(report.classes).some(x => x.failed.length);
  if (anyFail) { fs.writeFileSync(path.join(OUTB, "failed.jsonl"), Object.values(report.classes).flatMap(x => x.failed).map(o => JSON.stringify(o)).join("\n") + "\n"); log("FAILED items -> build/vector-index/failed.jsonl"); process.exitCode = 2; }
} catch (err) {
  console.error("ERROR: " + (err && err.stack || err)); process.exitCode = 1;
} finally {
  if (server && server.proc && !server.proc.killed) { try { server.proc.kill(); log("server stopped pid=" + server.proc.pid); } catch {} }
}
}

const IS_MAIN = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) await main();

