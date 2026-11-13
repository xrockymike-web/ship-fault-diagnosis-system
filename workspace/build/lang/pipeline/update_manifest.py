import hashlib, hashlib as h, io
from pathlib import Path
p = Path("workspace/data/chunk/chunks_en.jsonl")
data = p.read_bytes()
sha = hashlib.sha256(data).hexdigest()
lines = data.count(b"\n")
mf = Path("workspace/data/chunk/MANIFEST.sha256")
text = mf.read_text(encoding="utf-8")
tag = "chunk/chunks_en.jsonl"
if tag not in text:
    text = text.rstrip("\n") + "\n" + sha + "  " + str(len(data)) + "  " + str(lines) + "  " + tag + "\n"
    mf.write_text(text, encoding="utf-8")
print("sha", sha[:16], "bytes", len(data), "lines", lines)
print("manifest ok", tag in mf.read_text(encoding="utf-8"))