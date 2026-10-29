# scripts/public-readiness.ps1
param(
  [string]$TargetDir = (Get-Location).Path
)

$script = Join-Path $PSScriptRoot "public-readiness"
node $script $TargetDir
exit $LASTEXITCODE
