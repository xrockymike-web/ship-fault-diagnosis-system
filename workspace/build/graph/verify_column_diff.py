# -*- coding: utf-8 -*-
"""列级 diff：比较两份 CSV 的每一列（按列哈希 + 逐行差异计数）。

用途（3.3.4 验收）：证明写回 attributes 之后，entities.csv 其余列一字未动。
用法：python verify_column_diff.py <旧.csv> <新.csv> [--col attributes]
"""
import csv, hashlib, sys


def load(path):
    with open(path, encoding="utf-8", newline="") as f:
        rows = [r for r in csv.reader(f) if r and any(x.strip() for x in r)]
    return rows[0], rows[1:]


def col_values(hdr, rows, name):
    i = hdr.index(name)
    return [(r[i] if i < len(r) else "") for r in rows]


def colhash(vals):
    h = hashlib.sha256()
    for v in vals:
        h.update(v.encode("utf-8"))
        h.update(b"\n")
    return h.hexdigest()[:16]


def main():
    old, new = sys.argv[1], sys.argv[2]
    h1, r1 = load(old)
    h2, r2 = load(new)
    print("旧：%s  (%d 行 / %d 列)" % (old, len(r1), len(h1)))
    print("新：%s  (%d 行 / %d 列)" % (new, len(r2), len(h2)))
    if h1 != h2:
        print("!! 表头不同：")
        print("   旧:", h1)
        print("   新:", h2)
    if len(r1) != len(r2):
        print("!! 行数不同：%d -> %d" % (len(r1), len(r2)))
    changed, same, missing = [], [], []
    for name in h1:
        if name not in h2:
            missing.append(name)
            continue
        va, vb = col_values(h1, r1, name), col_values(h2, r2, name)
        if len(va) == len(vb) and va == vb:
            same.append(name)
        else:
            n = sum(1 for a, b in zip(va, vb) if a != b) + abs(len(va) - len(vb))
            changed.append((name, n))
    print("\n未变动列 (%d)：%s" % (len(same), " / ".join(same)))
    if missing:
        print("新表缺失列：%s" % " / ".join(missing))
    if changed:
        print("\n变动列 (%d)：" % len(changed))
        for name, n in changed:
            print("  %-12s %d 行不同" % (name, n))
    else:
        print("\n✅ 两表所有共同列逐字节一致")
    # 逐列哈希表（便于记入证据）
    print("\n逐列哈希（前 16 位）：")
    for name in h1:
        if name in h2:
            print("  %-12s %s -> %s" % (name, colhash(col_values(h1, r1, name)),
                                        colhash(col_values(h2, r2, name))))


if __name__ == "__main__":
    main()
