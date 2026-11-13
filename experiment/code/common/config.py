#!/usr/bin/env python3
"""config.yaml + .env 读取。

安全红线：
- `.env` 里的 key 只允许被 Python 读进内存，**绝不打印**、绝不写日志、绝不进 git；
- 本模块对外只暴露 `env(name)` / `require_env(name)`，不提供 dump 全量 env 的接口；
- 异常信息只带变量名，不带值（`ConfigError` 由调用方打印）。

`config.yaml` 用 PyYAML 解析（已在 requirements.txt 声明）；缺 PyYAML 时给出明确报错，
不做"半吊子"自写 YAML 解析，避免配置被悄悄读错。
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import paths

try:  # PyYAML 是唯一第三方依赖；缺失时不应静默降级
    import yaml  # type: ignore
except Exception:  # pragma: no cover - 环境问题
    yaml = None


class ConfigError(RuntimeError):
    """配置/凭据缺失。消息中只允许出现变量名。"""


_CONFIG: dict[str, Any] | None = None
_ENV: dict[str, str] | None = None


# ---------------------------------------------------------------- config.yaml
def _load_yaml(path: Path) -> dict[str, Any]:
    if yaml is None:
        raise ConfigError(
            "需要 PyYAML 才能读取 config.yaml：pip install -r experiment/requirements.txt"
        )
    if not path.exists():
        raise ConfigError(f"配置文件不存在：{path}")
    with path.open(encoding="utf-8") as fh:
        data = yaml.safe_load(fh)
    if not isinstance(data, dict):
        raise ConfigError(f"config.yaml 顶层必须是映射：{path}")
    return data


def load_config(reload: bool = False) -> dict[str, Any]:
    global _CONFIG
    if _CONFIG is None or reload:
        _CONFIG = _load_yaml(paths.CONFIG_FILE)
    return _CONFIG


def cfg(*keys: str, default: Any = None) -> Any:
    """按层级取配置：cfg('budget', 'per_model_cny', 'deepseek-flash')。"""
    node: Any = load_config()
    for key in keys:
        if not isinstance(node, dict) or key not in node:
            return default
        node = node[key]
    return node


# ---------------------------------------------------------------- .env
def _parse_env_file(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        name = name.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if name:
            env[name] = value
    return env


def load_env(reload: bool = False) -> dict[str, str]:
    """读 `experiment/.env`；进程环境变量优先。返回副本，调用方不得打印。"""
    global _ENV
    if _ENV is None or reload:
        _ENV = _parse_env_file(paths.ENV_FILE)
    return dict(_ENV)


def env(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name)
    if value:
        return value
    return load_env().get(name, default)


def require_env(name: str) -> str:
    value = env(name)
    if not value:
        raise ConfigError(
            f"缺少环境变量 {name}；请写入 experiment/.env（不要提交、不要贴到聊天里）"
        )
    return value


def masked(value: str | None, keep: int = 4) -> str:
    """给日志展示用：只留尾部 4 位，其余打码。空值返回 '<unset>'。"""
    if not value:
        return "<unset>"
    if len(value) <= keep:
        return "*" * len(value)
    return "*" * (len(value) - keep) + value[-keep:]


# ---------------------------------------------------------------- 常用配置块
def usd_cny() -> float:
    return float(cfg("budget", "usd_cny", default=7.3))


def budget_cfg() -> dict[str, Any]:
    return cfg("budget", default={}) or {}


def per_model_cap_cny() -> dict[str, float]:
    caps = cfg("budget", "per_model_cny", default={}) or {}
    return {str(k): float(v) for k, v in caps.items()}


def max_calls() -> dict[str, int]:
    calls = cfg("budget", "max_calls", default={}) or {}
    return {str(k): int(v) for k, v in calls.items()}


def hard_stop() -> bool:
    return bool(cfg("budget", "hard_stop", default=True))


def pricing() -> dict[str, dict[str, float]]:
    table = cfg("pricing_usd_per_mtok", default={}) or {}
    return {
        str(model): {str(k): float(v) for k, v in row.items()}
        for model, row in table.items()
    }


def model_cfg(kind: str) -> dict[str, Any]:
    """kind = 'judge'（deepseek）或 'build'（qwen）。"""
    block = cfg("models", kind, default=None)
    if not isinstance(block, dict):
        raise ConfigError(f"config.yaml 缺少 models.{kind}")
    return block


def judge_model() -> str:
    return str(model_cfg("judge").get("model", "deepseek-flash"))


def build_model() -> str:
    return str(model_cfg("build").get("model", "qwen3.8-flash"))
