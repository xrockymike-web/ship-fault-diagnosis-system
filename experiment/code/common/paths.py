#!/usr/bin/env python3
"""experiment 路径唯一来源（对应《实验总纲》§12.2 / §12.3）。

约定：
- 所有脚本只从这里取路径，不要在各脚本里重复 `Path(__file__).parents[...]`；
- `workspace/**` 只读，本文件只"指路"，不做任何写入；
- `experiment/data_performance/` 下按样本分区：`first/`、`second/`，
  每个样本内部再分 `answer / question / report / score`；账本 `cost_ledger.jsonl`
  是跨样本的全局文件，放在 `data_performance/` 根。

路径解析：`paths.EXPERIMENT_DIR` 由本文件位置反推，因此仓库整体移动后仍可用。
"""
from __future__ import annotations

from pathlib import Path

# ---------------------------------------------------------------- 顶层目录
EXPERIMENT_DIR = Path(__file__).resolve().parents[2]        # experiment/
PROJECT_ROOT = EXPERIMENT_DIR.parent                         # 仓库根
CODE_DIR = EXPERIMENT_DIR / "code"
DATA_DIR = EXPERIMENT_DIR / "data_performance"

# ---------------------------------------------------------------- 代码/配置
CONFIG_FILE = EXPERIMENT_DIR / "config.yaml"
ENV_FILE = EXPERIMENT_DIR / ".env"
ENV_EXAMPLE_FILE = EXPERIMENT_DIR / ".env.example"
REQUIREMENTS_FILE = EXPERIMENT_DIR / "requirements.txt"

# ---------------------------------------------------------------- 只读语料
WORKSPACE_DIR = PROJECT_ROOT / "workspace"
DATA_SOURCE = WORKSPACE_DIR / "data"
CHUNK_DIR = DATA_SOURCE / "chunk"
CHUNKS_FILE = CHUNK_DIR / "chunks.jsonl"
GRAPH_DIR = DATA_SOURCE / "graph"
ENTITIES_FILE = GRAPH_DIR / "entities.csv"
TRIPLES_FILE = GRAPH_DIR / "triples.csv"
BOOK_FILE = DATA_SOURCE / "document" / "book.txt"

# ---------------------------------------------------------------- 数据分区
# 2026-10-24：第一/第二样本分家。默认 first，保持旧命令不动；
# 第二样本显式传 sample="second"（或命令行的 --sample second）。
SAMPLES = ("first", "second")
DEFAULT_SAMPLE = "first"
COST_LEDGER = DATA_DIR / "cost_ledger.jsonl"   # 跨样本的全局台账，不放进某个样本

# ---------------------------------------------------------------- 常量
STAGES = ("pool", "pilot", "main", "50questions")  # 50questions = 2026-10-19 合并题库（pool36 + pilot-v2 12 + 新增2 = 50题）  # pool = 出题候选池(2026-10-19): 30-40道筛选，终版12道领域题进pilot
SYSTEMS = ("ours", "lightrag", "naiverag", "no_graph")
QUESTION_TYPES = ("fact", "causal", "diagnostic", "refusal", "boundary")


def _check_stage(stage: str) -> str:
    if stage not in STAGES:
        raise ValueError(f"未知 stage: {stage!r}（只允许 {STAGES}）")
    return stage


def _check_system(system: str) -> str:
    if system not in SYSTEMS:
        raise ValueError(f"未知 system: {system!r}（只允许 {SYSTEMS}）")
    return system


def _check_sample(sample: str) -> str:
    if sample not in SAMPLES:
        raise ValueError(f"未知 sample: {sample!r}（只允许 {SAMPLES}）")
    return sample


# ---------------------------------------------------------------- 样本分区
def sample_dir(sample: str = DEFAULT_SAMPLE) -> Path:
    """data_performance/<first|second>/"""
    return DATA_DIR / _check_sample(sample)


# ---------------------------------------------------------------- 题目
def question_dir(stage: str, sample: str = DEFAULT_SAMPLE) -> Path:
    return sample_dir(sample) / "question" / _check_stage(stage)


def questions_file(stage: str, sample: str = DEFAULT_SAMPLE) -> Path:
    return question_dir(stage, sample) / "questions.json"


def manifest_file(stage: str, sample: str = DEFAULT_SAMPLE) -> Path:
    return question_dir(stage, sample) / "manifest.json"


def gate_report_file(stage: str, sample: str = DEFAULT_SAMPLE) -> Path:
    return question_dir(stage, sample) / "gate_report.jsonl"


def probe_report_file(stage: str, sample: str = DEFAULT_SAMPLE) -> Path:
    return question_dir(stage, sample) / "probe_report.jsonl"


def drafts_dir(stage: str, sample: str = DEFAULT_SAMPLE) -> Path:
    """草稿区：`_drafts/` 已在 experiment/.gitignore 中忽略。"""
    return question_dir(stage, sample) / "_drafts"


# ---------------------------------------------------------------- 运行产物
def answer_dir(system: str, stage: str, sample: str = DEFAULT_SAMPLE) -> Path:
    return sample_dir(sample) / "answer" / _check_system(system) / _check_stage(stage)


def runs_dir(system: str, stage: str, question_id: str, sample: str = DEFAULT_SAMPLE) -> Path:
    return answer_dir(system, stage, sample) / "runs" / question_id


def score_machine_dir(system: str, stage: str, sample: str = DEFAULT_SAMPLE) -> Path:
    """最后分数：data_performance/<sample>/score/<arm>/<stage>/。"""
    return sample_dir(sample) / "score" / _check_system(system) / _check_stage(stage)


def report_dir(system: str, stage: str, sample: str = DEFAULT_SAMPLE) -> Path:
    """判分明细：data_performance/<sample>/report/<arm>/<stage>/（verdicts 等）。"""
    return sample_dir(sample) / "report" / _check_system(system) / _check_stage(stage)


# ---------------------------------------------------------------- 小工具
def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def rel(path: Path) -> str:
    """给日志/报告用的相对路径（相对 experiment/，统一 / 分隔）。"""
    path = Path(path)
    try:
        return path.resolve().relative_to(EXPERIMENT_DIR).as_posix()
    except ValueError:
        return path.as_posix()
