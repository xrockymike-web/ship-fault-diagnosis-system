<#
  chunk + graph rebuild pipeline (ASCII only: Windows PowerShell 5.1 reads .ps1 as ANSI)
  Usage: powershell -File workspace\build\chunk\rebuild_chunks.ps1 -Data <data dir>
#>
param(
  [Parameter(Mandatory=$true)][string]$Data,
  [string]$OldDb = "workspace\data\vector-index\chunk\chunk.sqlite"
)
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$Py = Join-Path $Root 'workspace\environment\python\python.exe'
$Node = Join-Path $Root 'workspace\environment\nodejs\node-v24.21.0-win-x64\node.exe'
$D = (Resolve-Path (Join-Path $Root $Data)).Path
$Old = (Resolve-Path (Join-Path $Root $OldDb)).Path
$V = Join-Path $D 'build\vector-index'
$O = Join-Path $D 'vector-index'

function Step($name, $block) {
  Write-Host "=== $name" -ForegroundColor Cyan
  & $block
  if ($LASTEXITCODE -ne 0) { throw "step failed: $name (exit $LASTEXITCODE)" }
}

Step '1 chunk (semantic + LLM -> DP)' { & $Py (Join-Path $Root 'workspace\build\chunk\build_chunks.py') --data $D --alpha 0.6 --beta 0.4 --lam 8 --per-parent 4 }
Step '2 verify chunks'               { & $Py (Join-Path $Root 'workspace\build\chunk\verify_chunks.py') --data $D }
Step '3 remap graph refs'            { & $Py (Join-Path $Root 'workspace\build\chunk\remap_graph_refs.py') --data $D --old-db $Old }
Step '4 embed'                       { & $Node (Join-Path $Root 'workspace\build\vector-index\embed_build.mjs') --data $D --out $V --reset chunk --only chunk,entity,triple }
Step '5 build db'                    { & $Py (Join-Path $Root 'workspace\build\index\build_db.py') --data $D --vec $V --out $O }
Step '6 manifest'                    { & $Py (Join-Path $Root 'workspace\build\index\make_manifest.py') --data $D --vec $V --dir $O }
Step '7 verify db'                   { & $Py (Join-Path $Root 'workspace\build\index\verify_db.py') --dir $O }
Step '8 rebuild equivalence'         { & $Py (Join-Path $Root 'workspace\build\index\rebuild.py') --data $D --vec $V --dir $O }
Step '9 manifest again'              { & $Py (Join-Path $Root 'workspace\build\index\make_manifest.py') --data $D --vec $V --dir $O }
Step '10 gold migration'             { & $Py (Join-Path $Root 'workspace\build\chunk\migrate_gold.py') --data $D --old-db $Old --questions (Join-Path $Root 'experiment\data_performance\question\merged50\questions.json') --out (Join-Path $D 'experiment\merged50_questions.migrated.json') }
Write-Host "=== DONE -> $D" -ForegroundColor Green
