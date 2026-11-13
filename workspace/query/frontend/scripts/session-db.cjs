#!/usr/bin/env node
/**
 * 会话库检查工具（目标 2.5 验收用；只读或按参数改状态，不碰其它文件）。
 *
 * 用法：
 *   node scripts/session-db.cjs <db> dump                # 打印会话与消息（含 status/首字/结束时间）
 *   node scripts/session-db.cjs <db> plant-streaming     # 把最后一条助手消息改成 status='streaming'（模拟崩溃残留）
 *   node scripts/session-db.cjs <db> stats               # 只打印计数
 *   node scripts/session-db.cjs <db> exec "<SQL>"        # 任意 SQL（排障用）
 *
 * 用仓库内置 Node 24 的 node:sqlite（免 flag）—— 与运行时同一条驱动。
 */
const { DatabaseSync } = require('node:sqlite')

const [dbFile, cmd, arg] = process.argv.slice(2)
if (!dbFile || !cmd) {
  console.log('usage: node session-db.cjs <db> dump|plant-streaming|stats|exec "<SQL>"')
  process.exit(2)
}
const db = new DatabaseSync(dbFile)
db.exec('PRAGMA foreign_keys = ON;')

if (cmd === 'dump' || cmd === 'stats') {
  const sessions = db.prepare('SELECT id, title, created_at, updated_at FROM sessions ORDER BY updated_at DESC').all()
  console.log('sessions = ' + sessions.length)
  for (const s of sessions) {
    const msgs = db.prepare('SELECT id, seq, role, status, length(content) AS len, first_token_at, finished_at, error FROM messages WHERE session_id = ? ORDER BY seq').all(s.id)
    console.log('  [' + s.id + '] "' + s.title + '"  messages=' + msgs.length + '  updated=' + new Date(Number(s.updated_at)).toISOString())
    if (cmd === 'dump') {
      for (const m of msgs) {
        console.log('      seq=' + m.seq + ' ' + m.role.padEnd(9) + ' status=' + String(m.status).padEnd(9) + ' len=' + String(m.len).padStart(4) +
          ' firstToken=' + (m.first_token_at === null ? '-' : 'y') + ' finished=' + (m.finished_at === null ? '-' : 'y') +
          (m.error ? '  error="' + m.error + '"' : ''))
      }
    }
  }
} else if (cmd === 'plant-streaming') {
  const row = db.prepare("SELECT id FROM messages WHERE role = 'assistant' ORDER BY rowid DESC LIMIT 1").get()
  if (!row) { console.log('没有助手消息可改'); process.exit(1) }
  db.prepare("UPDATE messages SET status='streaming', finished_at=NULL WHERE id = ?").run(row.id)
  console.log('已把消息 ' + row.id + ' 置为 streaming（模拟上次崩溃残留）')
} else if (cmd === 'exec') {
  db.exec(arg)
  console.log('exec ok: ' + arg)
} else {
  console.log('未知命令：' + cmd)
  process.exit(2)
}
