<#
  模块结构校验（冻结清单比对）
  ------------------------------------------------------------------
  冻结依据：《技术路线总纲》§7.1.1、query/README.md §二
  冻结日期：2026-09-27
  冻结内容：10 个模块目录名单 / 三类划分 / launcher 的 5 个子目录 / config 的 6 个子目录
  用法：.\verify-structure.ps1        一致 → 退出码 0；不一致 → 列出差异并退出码 1
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# ---------------- 冻结清单（改动此处 = 违反冻结条款）----------------
$modules = @(
  'frontend', 'launcher', 'qa-core', 'config', 'shared',
  'text-retrieval', 'graph-retrieval', 'evidence-prompt', 'answer-generation'
)
$subdirs = @{
  'launcher' = @('bootstrap', 'process-manager', 'health-check', 'diagnostics', 'resources')
  'config'   = @('application', 'models', 'prompts', 'retrieval', 'evidence', 'logging')
}
$allowedExtra = @('bin')   # 开发态运行目录（已在《阶段1开发过程》登记，不属于模块）
# ------------------------------------------------------------------

$fail = New-Object System.Collections.Generic.List[string]
$present = @(Get-ChildItem $root -Directory | ForEach-Object { $_.Name })

foreach ($m in $modules) {
  if ($present -notcontains $m) { $fail.Add("缺少模块目录：$m") }
}
foreach ($p in $present) {
  if (($modules -notcontains $p) -and ($allowedExtra -notcontains $p)) {
    $fail.Add("出现冻结清单外的目录：$p")
  }
}
foreach ($k in $subdirs.Keys) {
  if ($present -contains $k) {
    $sub = @(Get-ChildItem (Join-Path $root $k) -Directory | ForEach-Object { $_.Name })
    foreach ($s in $subdirs[$k]) {
      if ($sub -notcontains $s) { $fail.Add("$k/ 缺少子目录：$s") }
    }
  }
}

"冻结清单：$($modules.Count) 个模块 + $($subdirs.Count) 组子目录规则"
"实际目录：$($present -join ', ')"
if ($fail.Count -eq 0) {
  "结果：OK —— 与冻结清单一致"
  exit 0
}
"结果：FAIL —— 发现 $($fail.Count) 处不一致"
$fail | ForEach-Object { "   - $_" }
exit 1
