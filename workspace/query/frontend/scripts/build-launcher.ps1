<#
  一级启动器构建（目标 2 步骤 2.6b，决策 D2-6 / D2-14）
  ------------------------------------------------------------------
  零下载：用 Windows 自带的 .NET Framework csc.exe（C# 5）。
  产物：scripts\build\launcher.exe（含图标；不进 git —— scripts/build/ 已忽略）
  用法：npm run build:launcher     （或 powershell -File scripts/build-launcher.ps1）
#>
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path          # query/frontend/scripts
$query = Split-Path -Parent (Split-Path -Parent $here)           # query/
$src = Join-Path $here 'launcher.cs'
$icon = Join-Path $query 'launcher\resources\icon.ico'
$outDir = Join-Path $here 'build'
$out = Join-Path $outDir 'launcher.exe'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'

if (-not (Test-Path $csc)) { throw "缺少 csc.exe：$csc —— 目标机器需要 .NET Framework 4.x（Win10/11 自带）" }
if (-not (Test-Path $src)) { throw "缺少源码：$src" }
if (-not (Test-Path $icon)) { throw "缺少图标：$icon —— 先用 make-icon.exe 从 anchor.png 生成" }

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# 源码必须 UTF-8 **带 BOM**：否则 csc 按 ANSI(936) 读，弹框里的中文会乱码（施工单 §4.7 P22）
$text = [System.IO.File]::ReadAllText($src, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText($src, $text, [System.Text.UTF8Encoding]::new($true))

# /target:winexe = GUI 子系统（双击不闪黑框）；/codepage:65001 与 BOM 双保险
& $csc /nologo /target:winexe /codepage:65001 /win32icon:"$icon" /out:"$out" "$src"
if ($LASTEXITCODE -ne 0) { throw "csc 失败，退出码 $LASTEXITCODE" }

$fi = Get-Item $out
"[launcher] OK  $out（$($fi.Length) B，含图标）"

# D2-31 乙：同一份启动器也放到 workspace/ 根（源码区入口；双击 → 拉起 bin\船舶故障诊断系统.exe）
$wsRoot = Split-Path -Parent $query          # workspace/
Copy-Item $out (Join-Path $wsRoot '船舶故障诊断系统.exe') -Force
$batLines = @(
  '@echo off',
  'rem Fallback entry (workspace). ASCII-only: cmd.exe reads .bat in the OEM code page.',
  'for %%f in ("%~dp0bin\*.exe") do start "" "%%~ff"'
)
[System.IO.File]::WriteAllLines((Join-Path $wsRoot '启动.bat'), $batLines, [System.Text.ASCIIEncoding]::new())
Write-Output ('[launcher] 开发态入口：' + (Join-Path $wsRoot '船舶故障诊断系统.exe') + ' + 启动.bat')
