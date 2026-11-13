# 布局冻结校验（D2-31「乙」，2026-09-27 项目负责人决定并冻结）
# ------------------------------------------------------------------
# 冻结对象：**两区顶层结构**与**程序/运行时落点**。谁改了都要在这里报错。
# 2026-10-22：模块清单 10 → 9（本脚本与 docs 对齐）。
#   源码区  workspace/{query, bin, data, environment, build}
#           workspace/query/          9 个模块目录（纯源码，不得出现 bin/ 或 dist/）
#           workspace/bin/            Electron 运行时 + 入口 exe
#           workspace/bin/resources/app/   构建产物（程序树；开发态直接跑）
#   交付态  portable/{query, bin, data, environment} + 一级启动器 + 启动.bat
#           portable/query/           9 个模块目录（与 workspace/query 同名同构）
#           portable/bin/             Electron 运行时 + 入口 exe + resources/app（两行跳板）
# 用法：pwsh -File workspace\verify-layout.ps1        （退出码 0=一致，1=有差异）
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path      # workspace/
$root = Split-Path -Parent $here                             # 项目根

$bad = New-Object System.Collections.Generic.List[string]
function Need-Dir([string]$p, [string]$what) { if (-not (Test-Path -LiteralPath $p -PathType Container)) { $bad.Add("缺目录：$p（$what）") } }
function Need-File([string]$p, [string]$what) { if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { $bad.Add("缺文件：$p（$what）") } }
function No-Entry([string]$p, [string]$what) { if (Test-Path -LiteralPath $p) { $bad.Add("不应存在：$p（$what）") } }

$MODULES = @('answer-generation','config','evidence-prompt','frontend','graph-retrieval','launcher','qa-core','shared','text-retrieval')

Write-Host '=== 源码区 workspace/ ==='
foreach ($d in @('query','bin','data','environment')) { Need-Dir (Join-Path $here $d) "顶层四件套" }
Need-Dir (Join-Path $here 'build') '知识库中间产物区'
foreach ($m in $MODULES) { Need-Dir (Join-Path $here "query\$m") '模块目录' }
Need-File (Join-Path $here 'query\README.md') '源码区说明'
Need-File (Join-Path $here 'query\verify-structure.ps1') '模块结构校验脚本'
No-Entry (Join-Path $here 'query\bin') '构建产物不得落在源码目录里（D2-31 乙）'
No-Entry (Join-Path $here 'query\dist') '构建产物不得落在源码目录里（D2-31 乙）'
Need-File (Join-Path $here 'bin\船舶故障诊断系统.exe') 'Electron 入口 exe'
Need-File (Join-Path $here 'bin\icudtl.dat') 'Electron 运行时'
Need-File (Join-Path $here 'bin\resources.pak') 'Electron 运行时'
Need-Dir  (Join-Path $here 'bin\locales') 'Electron 语言包'
Need-File (Join-Path $here 'bin\resources\app\main.js') '开发态构建产物（程序树）'
Need-File (Join-Path $here 'bin\resources\app\qa-core\index.js') '开发态构建产物（qa-core）'

Write-Host '=== 交付态 portable/ ==='
$p = Join-Path $root 'portable'
if (Test-Path -LiteralPath $p) {
  foreach ($d in @('query','bin','data','environment')) { Need-Dir (Join-Path $p $d) '顶层四件套' }
  Need-File (Join-Path $p '船舶故障诊断系统.exe') '一级启动器'
  Need-File (Join-Path $p '启动.bat') '兜底入口'
  foreach ($m in $MODULES) { Need-Dir (Join-Path $p "query\$m") '交付态模块目录' }
  Need-File (Join-Path $p 'query\main.js') '程序入口'
  Need-File (Join-Path $p 'query\package.json') '程序清单'
  Need-File (Join-Path $p 'bin\船舶故障诊断系统.exe') 'Electron 入口 exe'
  Need-File (Join-Path $p 'bin\resources\app\package.json') '跳板清单'
  Need-File (Join-Path $p 'bin\resources\app\loader.js') '跳板 loader'
  $loader = Get-Content -LiteralPath (Join-Path $p 'bin\resources\app\loader.js') -Raw
  if ($loader -notmatch "require\('\.\./\.\./\.\./query/main\.js'\)") {
    $bad.Add("跳板内容不对：bin\resources\app\loader.js 必须是 require('../../../query/main.js')")
  }
  Need-Dir (Join-Path $p 'data\runtime') '唯一可写目录'
} else { Write-Host '  （portable/ 不存在，跳过——未组装时属正常）' }

Write-Host ''
if ($bad.Count -eq 0) {
  Write-Host '结果：OK —— 与冻结布局一致（D2-31 乙）'
  exit 0
} else {
  Write-Host ('结果：**不一致**，' + $bad.Count + ' 处：')
  foreach ($b in $bad) { Write-Host ('  ✗ ' + $b) }
  Write-Host ''
  Write-Host '布局已冻结（《技术路线总纲》§7.1.1 / D2-31）：改动前必须先写一条书面决策，再改本脚本与文档。'
  exit 1
}
