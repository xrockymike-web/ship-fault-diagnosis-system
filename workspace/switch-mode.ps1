# switch-mode.ps1 — switch answer.backend between cpu / cuda / auto.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File switch-mode.ps1 -Mode cpu|cuda|auto
param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("cpu","cuda","auto")]
    [string]$Mode
)

$ErrorActionPreference = "Stop"

$paths = @(
    (Join-Path $PSScriptRoot "query\config\models\default.json"),
    (Join-Path $PSScriptRoot "bin\resources\app\config\models\default.json")
)

foreach ($p in $paths) {
    if (!(Test-Path $p)) {
        Write-Host "SKIP (not found): $p"
        continue
    }

    $raw = [System.IO.File]::ReadAllText($p, [System.Text.UTF8Encoding]::new($false))

    # Only patch answer.backend — locate the "answer": { ... } object and replace
    # the first "backend" key inside it. Simple approach: split on "answer": marker.
    $answerIdx = $raw.IndexOf('"answer"')
    if ($answerIdx -lt 0) {
        Write-Host "SKIP (no answer block): $p"
        continue
    }

    # Find the first "backend" after "answer"
    $backendPattern = '"backend"\s*:\s*"(auto|cpu|cuda)"'
    $afterAnswer = $raw.Substring($answerIdx)
    $m = [regex]::Match($afterAnswer, $backendPattern)
    if (!$m.Success) {
        Write-Host "SKIP (no backend key in answer block): $p"
        continue
    }

    # Compute absolute index
    $absIdx = $answerIdx + $m.Index
    $oldVal = $m.Groups[1].Value
    if ($oldVal -eq $Mode) {
        Write-Host "ALREADY $Mode : $p"
        continue
    }

    $newRaw = $raw.Substring(0, $absIdx) + $m.Value.Replace("`"$oldVal`"", "`"$Mode`"") + $raw.Substring($absIdx + $m.Length)
    [System.IO.File]::WriteAllText($p, $newRaw, [System.Text.UTF8Encoding]::new($false))
    Write-Host "OK  answer.backend: $oldVal -> $Mode : $p"
}

Write-Host ""
Write-Host "Switched answer.backend to '$Mode'. Restart the app to take effect."
