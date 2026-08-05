[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function setDatabaseUrl([string]$directory, [string]$databaseUrl) {
  Set-Content -LiteralPath (Join-Path $directory '.env') -Value "DATABASE_URL=$databaseUrl"
}

function expectFailure([string]$name, [string]$expectedMessage, [scriptblock]$operation) {
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $result = & $operation 2>&1
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($LASTEXITCODE -eq 0) {
    throw "$name unexpectedly succeeded."
  }
  if (($result | Out-String) -notmatch [Regex]::Escape($expectedMessage)) {
    throw "$name failed for an unexpected reason. Expected: $expectedMessage"
  }
}

$testDirectory = Join-Path $env:TEMP ("osleaders-private-beta-tests-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $testDirectory | Out-Null

try {
  $backupScript = Join-Path $PSScriptRoot 'backup-private-beta-database.ps1'
  $restoreScript = Join-Path $PSScriptRoot 'restore-private-beta-rehearsal.ps1'
  $backupDirectory = Join-Path $testDirectory 'backups'
  $backupFile = Join-Path $testDirectory 'fixture.dump'
  $missingBinDirectory = Join-Path $testDirectory 'missing-bin'
  New-Item -ItemType Directory -Path $backupDirectory | Out-Null
  Set-Content -LiteralPath $backupFile -Value 'not a PostgreSQL backup'

  setDatabaseUrl $testDirectory 'postgresql://test_user:secret@example.invalid:5432/osleaders_dev'
  expectFailure 'backup rejects a remote host' 'must target localhost, 127.0.0.1, or ::1' {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $backupScript -DestinationDirectory $backupDirectory -ProjectDirectory $testDirectory
  }
  expectFailure 'restore rejects a remote host' 'must target localhost, 127.0.0.1, or ::1' {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $restoreScript -BackupPath $backupFile -RehearsalDatabaseName osleaders_rehearsal -ProjectDirectory $testDirectory
  }

  setDatabaseUrl $testDirectory 'postgresql://test_user:secret@[::1]:5432/osleaders_dev'
  expectFailure 'backup accepts IPv6 loopback and reaches tool resolution' 'pg_dump.exe was not found' {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $backupScript -DestinationDirectory $backupDirectory -ProjectDirectory $testDirectory -PostgreSqlBinDirectory $missingBinDirectory
  }
  expectFailure 'restore accepts IPv6 loopback and reaches tool resolution' 'createdb.exe was not found' {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $restoreScript -BackupPath $backupFile -RehearsalDatabaseName osleaders_rehearsal -ProjectDirectory $testDirectory -PostgreSqlBinDirectory $missingBinDirectory
  }

  setDatabaseUrl $testDirectory 'postgresql://test_user:secret@localhost:5432/osleaders_dev'
  expectFailure 'restore refuses the live configured database name' 'RehearsalDatabaseName must not be the database configured' {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $restoreScript -BackupPath $backupFile -RehearsalDatabaseName osleaders_dev -ProjectDirectory $testDirectory
  }
} finally {
  Remove-Item -LiteralPath $testDirectory -Recurse -Force
}
