#!/usr/bin/env python3
"""JSON / JSONL 读写、sha256、时间戳、原子写入。

命名说明：交接文档 §12.2 写的是 `io.py`；但 Python 启动时已把标准库 `io` 放进
`sys.modules`，本地同名文件无法被 `import io` 加载，故落地为 `jsonio.py`
（功能与口径不变，脚本用 `import jsonio as io`）。

设计要点：
- 写入一律"先写临时文件再替换"，避免中途崩溃留下半个 questions.json；
- JSONL 追加用 `a` 模式，每行一个对象，方便 ledger 这种只追加的文件；
- 读取 JSONL 跳过空行，报错时带行号，便于定位手工编辑错误。
"""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator


# ---------------------------------------------------------------- 时间
def now_iso() -> str:
    """带时区的 ISO 时间（本地时区偏移保留，便于对照交接文档）。"""
    return datetime.now().astimezone().isoformat(timespec="seconds")


def now_utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------- JSON
def read_json(path: Path, default: Any = None) -> Any:
    path = Path(path)
    if not path.exists():
        return default
    with path.open(encoding="utf-8") as fh:
        return json.load(fh)


def write_json(path: Path, data: Any, *, indent: int = 2) -> Path:
    """原子写：同目录临时文件 -> os.replace。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, indent=indent) + "\n"
    _atomic_write_text(path, text)
    return path


def _atomic_write_text(path: Path, text: str) -> None:
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
        os.replace(tmp, path)
    finally:
        try:
            if os.path.exists(tmp):
                os.unlink(tmp)
        except OSError:
            pass


# ---------------------------------------------------------------- JSONL
def read_jsonl(path: Path) -> Iterator[dict[str, Any]]:
    path = Path(path)
    if not path.exists():
        return
    with path.open(encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{lineno} JSONL 解析失败：{exc}") from exc
            if not isinstance(obj, dict):
                raise ValueError(f"{path}:{lineno} 每行必须是 JSON 对象")
            yield obj


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    text = "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows)
    _atomic_write_text(path, text)
    return path


def append_jsonl(path: Path, row: dict[str, Any]) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    return path


# ---------------------------------------------------------------- 哈希
def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def sha256_json(data: Any) -> str:
    """稳定序列化后哈希（key 排序、无空格），用于 manifest 指纹。"""
    return sha256_text(json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
