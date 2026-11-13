#!/usr/bin/env node
/**
 * 读 ZIP 的中央目录，逐条打印：条目名 + **UTF-8 标志位（通用位标志 bit 11 / 0x0800）** + 压缩方式。
 * 目标 2.7 的 Q7-6 取证工具：中文名会不会在解压侧乱码，就看这一位。
 *
 * ⚠️ 只**有界读取**（尾部 + 中央目录），不整文件读入 —— 我们的包 2.5 GiB，超过 Node 的 2 GiB Buffer 上限。
 * 支持 zip64（>4 GiB / >65535 条目）。
 *
 * 用法：node scripts/zipinfo.cjs <file.zip> [--names-only]
 */
const fs = require('node:fs')

const file = process.argv[2]
const namesOnly = process.argv.includes('--names-only')
if (!file) { console.log('usage: node zipinfo.cjs <file.zip> [--names-only]'); process.exit(2) }

const fd = fs.openSync(file, 'r')
const size = fs.fstatSync(fd).size
const readAt = (pos, len) => {
  const buf = Buffer.alloc(Math.min(len, Math.max(0, size - pos)))
  fs.readSync(fd, buf, 0, buf.length, pos)
  return buf
}

// 1) EOCD（0x06054b50）在最后 64 KB 内
const tailLen = Math.min(65536, size)
const tail = readAt(size - tailLen, tailLen)
let eocdRel = -1
for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocdRel = i; break }
if (eocdRel < 0) { console.log('找不到 EOCD —— 不是 zip 或已损坏'); process.exit(1) }
const eocdPos = size - tailLen + eocdRel

let total = tail.readUInt16LE(eocdRel + 10)
let cdOffset = tail.readUInt32LE(eocdRel + 16)
let cdSize = tail.readUInt32LE(eocdRel + 12)

// 2) zip64：EOCD 之前 20 字节处有 zip64 EOCD locator（0x07064b50）
if (total === 0xffff || cdOffset === 0xffffffff) {
  const locPos = eocdPos - 20
  if (locPos >= 0) {
    const loc = readAt(locPos, 20)
    if (loc.readUInt32LE(0) === 0x07064b50) {
      const z64Pos = Number(loc.readBigUInt64LE(8))
      const z64 = readAt(z64Pos, 56)
      total = Number(z64.readBigUInt64LE(32))
      cdSize = Number(z64.readBigUInt64LE(40))
      cdOffset = Number(z64.readBigUInt64LE(48))
      console.log('（zip64：中央目录偏移 ' + cdOffset + '，大小 ' + cdSize + '）')
    }
  }
}

console.log('文件：' + file)
console.log('大小：' + size + ' B (' + (size / 1024 / 1024).toFixed(1) + ' MiB)')
console.log('条目数：' + total)

const cd = readAt(cdOffset, cdSize)
let p = 0
let utf8 = 0, ansi = 0, stored = 0, other = 0
let bad = []
const tops = new Set()
const samples = []
for (let n = 0; n < total; n++) {
  if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) { console.log('中央目录第 ' + n + ' 条签名不对，停止'); break }
  const flags = cd.readUInt16LE(p + 8)
  const method = cd.readUInt16LE(p + 10)
  let nameLen = cd.readUInt16LE(p + 28)
  let extraLen = cd.readUInt16LE(p + 30)
  const cmtLen = cd.readUInt16LE(p + 32)
  let nameOff = p + 46
  const nameBuf = cd.subarray(nameOff, nameOff + nameLen)
  const hasUtf8 = (flags & 0x0800) !== 0
  hasUtf8 ? utf8++ : ansi++
  method === 0 ? stored++ : other++
  const name = nameBuf.toString('utf8')
  tops.add(name.split(/[\\/]/)[0])
  if (samples.length < 8) samples.push({ name, hasUtf8, method })
  if (/(^|[\\/])(\.git|node_modules)([\\/]|$)/.test(name) || /\.log$/i.test(name) ||
      /(SOURCE|PERF)\.txt$/i.test(name) || /(sessions\.sqlite|hardware\.json)/.test(name) ||
      /chromium[\\/]/.test(name)) bad.push(name)
  p += 46 + nameLen + extraLen + cmtLen
}
console.log('UTF-8 标志位（bit 11）：置位 ' + utf8 + ' / 未置位 ' + ansi + (ansi === 0 ? '  ✓ 中文名不会乱码' : '  ✗ 有风险'))
console.log('压缩方式：存储 ' + stored + ' / 其它 ' + other + (other === 0 ? '  ✓ 存储模式' : ''))
console.log('顶层条目：' + [...tops].join(' | '))
console.log('内容禁令违规：' + bad.length + (bad.length ? ' → ' + bad.slice(0, 5).join(', ') : '  ✓'))
if (!namesOnly) {
  console.log('样本：')
  for (const s of samples) console.log('  [' + (s.hasUtf8 ? 'UTF8' : 'ANSI') + '][' + (s.method === 0 ? 'store' : 'deflate') + '] ' + s.name)
}
fs.closeSync(fd)
