/** 只读 SQLite 连接缓存（语言层与检索共用，避免每处各写一份）。 */
import { DatabaseSync } from 'node:sqlite'

const DBS = new Map<string, DatabaseSync>()
export function openRo(path: string): DatabaseSync {
  let db = DBS.get(path)
  if (!db) { db = new DatabaseSync(path, { readOnly: true }); DBS.set(path, db) }
  return db
}

