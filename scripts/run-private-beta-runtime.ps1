[CmdletBinding()]
param(
  [string]$ProjectDirectory = (Split-Path -Parent $PSScriptRoot),

  [ValidateRange(1, 3600)]
  [int]$RestartDelaySeconds = 60
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath (Join-Path $ProjectDirectory '.env') -PathType Leaf)) {
  throw 'The private-beta .env file was not found.'
}

$npm = (Get-Command 'npm.cmd' -ErrorAction Stop).Source
Push-Location $ProjectDirectory
try {
  while ($true) {
    & $npm run dev
    $exitCode = $LASTEXITCODE
    Write-Warning "OSLeaders stopped with exit code $exitCode; restarting in $RestartDelaySeconds seconds."
    Start-Sleep -Seconds $RestartDelaySeconds
  }
} finally {
  Pop-Location
}
