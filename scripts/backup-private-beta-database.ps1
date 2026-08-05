[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateNotNullOrEmpty()]
  [string]$DestinationDirectory,

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

if (-not (Test-Path -LiteralPath $DestinationDirectory -PathType Container)) {
  throw 'DestinationDirectory must be an available existing directory, preferably external storage.'
}

$connection = connectionParameters (databaseConnectionString $ProjectDirectory)
$databaseName = $connection.DatabaseName
$destination = (Resolve-Path -LiteralPath $DestinationDirectory).Path
$timestamp = Get-Date -Format 'yyyy-MM-dd-HHmmss'
$backupPath = Join-Path $destination "osleaders-$databaseName-$timestamp.dump"
$pgDump = executablePath 'pg_dump.exe'
$pgRestore = executablePath 'pg_restore.exe'

& $pgDump "--host=$($connection.Host)" "--port=$($connection.Port)" "--username=$($connection.Username)" "--dbname=$databaseName" '--format=custom' "--file=$backupPath"
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with exit code $LASTEXITCODE." }
if (-not (Test-Path -LiteralPath $backupPath -PathType Leaf) -or (Get-Item -LiteralPath $backupPath).Length -eq 0) { throw 'pg_dump did not create a non-empty backup file.' }
& $pgRestore '--list' $backupPath | Out-Null
if ($LASTEXITCODE -ne 0) { throw "pg_restore could not read the backup file (exit code $LASTEXITCODE)." }
Write-Output "Created and verified PostgreSQL backup: $backupPath"
