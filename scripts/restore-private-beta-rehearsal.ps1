[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateNotNullOrEmpty()]
  [string]$BackupPath,

  [Parameter(Mandatory)]
  [ValidatePattern('^[A-Za-z0-9_-]+$')]
  [string]$RehearsalDatabaseName,

  [string]$ProjectDirectory = (Split-Path -Parent $PSScriptRoot),

  [string]$PostgreSqlBinDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function databaseConnectionString([string]$projectDirectory) {
  $environmentFile = Join-Path $projectDirectory '.env'
  if (-not (Test-Path -LiteralPath $environmentFile -PathType Leaf)) {
    throw 'The private-beta .env file was not found.'
  }

  foreach ($line in Get-Content -LiteralPath $environmentFile) {
    if ($line -match '^\s*DATABASE_URL\s*=\s*(?<value>.+?)\s*$') {
      $value = $Matches.value
      if ($value.Length -ge 2 -and $value[0] -eq '"' -and $value[$value.Length - 1] -eq '"') {
        return $value.Substring(1, $value.Length - 2)
      }
      return $value
    }
  }

  throw 'DATABASE_URL must be set in the private-beta .env file.'
}

function connectionParameters([string]$connectionString) {
  try {
    $uri = [Uri]$connectionString
  } catch {
    throw 'DATABASE_URL must be a valid PostgreSQL connection URL.'
  }

  $databaseName = $uri.AbsolutePath.Trim('/')
  $username = ([Uri]::UnescapeDataString($uri.UserInfo) -split ':', 2)[0]
  $localHosts = @('localhost', '127.0.0.1', '::1', '[::1]')
  $databaseHost = normalizedHost $uri.Host
  if (
    $uri.Scheme -notin @('postgres', 'postgresql') -or
    $databaseHost -notin $localHosts -or
    [string]::IsNullOrWhiteSpace($uri.Host) -or
    [string]::IsNullOrWhiteSpace($username) -or
    [string]::IsNullOrWhiteSpace($databaseName) -or
    $databaseName -notmatch '^[A-Za-z0-9_-]+$'
  ) {
    throw 'DATABASE_URL must target localhost, 127.0.0.1, or ::1 with a user and valid database name.'
  }

  return [pscustomobject]@{
    DatabaseName = $databaseName
    Host = $databaseHost
    Port = if ($uri.IsDefaultPort) { 5432 } else { $uri.Port }
    Username = $username
  }
}

function normalizedHost([string]$rawHost) {
  $address = $null
  $hostWithoutBrackets = $rawHost.Trim('[', ']')
  if ([System.Net.IPAddress]::TryParse($hostWithoutBrackets, [ref]$address)) {
    return $address.ToString()
  }
  return $rawHost
}

function executablePath([string]$fileName) {
  if ([string]::IsNullOrWhiteSpace($PostgreSqlBinDirectory)) {
    return $fileName
  }

  $path = Join-Path $PostgreSqlBinDirectory $fileName
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "$fileName was not found in PostgreSqlBinDirectory."
  }
  return $path
}

if (-not (Test-Path -LiteralPath $BackupPath -PathType Leaf)) { throw 'BackupPath must be an existing backup file.' }
$connection = connectionParameters (databaseConnectionString $ProjectDirectory)
$runtimeDatabaseName = $connection.DatabaseName
if ($RehearsalDatabaseName.Equals($runtimeDatabaseName, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'RehearsalDatabaseName must not be the database configured in DATABASE_URL.' }
$createdb = executablePath 'createdb.exe'
$pgRestore = executablePath 'pg_restore.exe'
$psql = executablePath 'psql.exe'
& $createdb "--host=$($connection.Host)" "--port=$($connection.Port)" "--username=$($connection.Username)" '--maintenance-db=postgres' $RehearsalDatabaseName
if ($LASTEXITCODE -ne 0) { throw "createdb failed with exit code $LASTEXITCODE. The rehearsal database must not already exist." }
& $pgRestore "--host=$($connection.Host)" "--port=$($connection.Port)" "--username=$($connection.Username)" "--dbname=$RehearsalDatabaseName" '--no-owner' '--exit-on-error' $BackupPath
if ($LASTEXITCODE -ne 0) { throw "pg_restore failed with exit code $LASTEXITCODE. The private-beta database was not changed; the empty or partial rehearsal database remains for inspection and must be removed manually before retrying with the same name." }
$tables = & $psql "--host=$($connection.Host)" "--port=$($connection.Port)" "--username=$($connection.Username)" "--dbname=$RehearsalDatabaseName" '--tuples-only' '--no-align' "--command=SELECT to_regclass('public.guilds'), to_regclass('public.daily_recap_runs');"
if ($LASTEXITCODE -ne 0 -or (($tables -join "`n") -notmatch 'guilds\|daily_recap_runs')) { throw 'The rehearsal restore did not contain the expected OSLeaders tables.' }
Write-Output "Restored and verified rehearsal database: $RehearsalDatabaseName"
