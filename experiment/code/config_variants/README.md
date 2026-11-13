# config_variants —— 四臂实验的“实验侧配置”

> 建立：2026-10-23。目的：**检索配置与软件逐字节一致，提示词允许实验侧不同**（负责人 2026-10-23 拍板）。

## 不变量（改这里之前先读）

| 文件 | ours 变体 | no_graph 变体 |
|---|---|---|
| `config/retrieval/default.json` | 与 `workspace/query/config` **逐字节相同**（sha `F994EB70…`） | 只差 **1 行**：`graph.enabled: true → false` |
| `config/models`、`application`、`logging/` | 与产品相同 | 与产品相同 |
| `config/evidence/default.json` | 与产品相同，另加 `includeDiagnostics=false`、`rulesStyle=minimal` | 同 ours |
| `config/prompts/default.json` | `grounded` 只有一句角色 | 同 ours |

也就是说：**检索策略 = 软件**；**提示词 = 实验统一口径**。

## 回答口径（四臂的统一约束）

四臂都只保留两条：**只依据资料回答、不足就说不足**；**总长 300–450 字**。
具体落点：

- ours / no_graph：`config/prompts/default.json` 的 `grounded` 只有一句角色
  （`你是船舶电气设备的故障诊断助手。`）；规则由 app 的 `MINIMAL_RULES` 注入，
  长度由 `MINIMAL_TAIL` 追加（见 `workspace/query/evidence-prompt/index.ts`）。
- naiverag：`runner.py` 的 `SYSTEM_PROMPT` 为“只依据给定的资料回答；资料不足时说明”，
  长度要求放在 user 消息末尾。
- lightrag：不改官方 prompt；问题末尾经 `QueryParam.user_prompt` 追加长度要求。

## 用法

```powershell
python experiment\code\systems\ours\run_batch.py --system ours     --stage 50questions --program experiment\config_variants\ours
python experiment\code\systems\ours\run_batch.py --system no_graph --stage 50questions --app workspace\bin\resources\app --program experiment\config_variants\no_graph
```

## 预算（2026-10-24 最终口径）

| 臂 | 注入条数 | 正文预算 | 总量上限 |
|---|---:|---|---:|
| ours | 3（finalK） | 3,400 token（×1.6 = 5,440 字） | 5,250 token |
| no_graph | 3 | 3,400 token | 3,400 token |
| naiverag | 12（`--max-ctx-items` 默认） | 3,776 字（`--char-budget` 默认） | 3,776 字 |
| lightrag | 自管 | — | 5,250 token |

## 校验

```powershell
# ours 的检索配置必须与产品同 sha
(Get-FileHash workspace\query\config\retrieval\default.json).Hash
(Get-FileHash experiment\config_variants\ours\config\retrieval\default.json).Hash
# no_graph 只允许差 graph.enabled 一行
git diff --no-index workspace\query\config\retrieval\default.json experiment\config_variants\no_graph\config\retrieval\default.json
```
