$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
node "$scriptDir/verify-citations.mjs" $args
exit $LASTEXITCODE
