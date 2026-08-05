#!/usr/bin/env bash
set -euo pipefail

project_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
environment_file="$project_directory/.env"
destination_directory="${OSLEADERS_BACKUP_DIRECTORY:-}"
expected_mount="${OSLEADERS_BACKUP_MOUNT:-}"
retention_days="${OSLEADERS_BACKUP_RETENTION_DAYS:-}"

usage() {
  echo "Usage: $0 --destination DIRECTORY --expected-mount MOUNTPOINT --retention-days DAYS [--environment-file FILE] [--project-directory DIRECTORY]" >&2
  exit 2
}

while (($# > 0)); do
  case "$1" in
    --destination) destination_directory="${2:-}"; shift 2 ;;
    --expected-mount) expected_mount="${2:-}"; shift 2 ;;
    --retention-days) retention_days="${2:-}"; shift 2 ;;
    --environment-file) environment_file="${2:-}"; shift 2 ;;
    --project-directory) project_directory="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ -n "$destination_directory" && -n "$expected_mount" && "$retention_days" =~ ^[1-9][0-9]*$ ]] || usage
[[ -d "$destination_directory" && -d "$expected_mount" ]] || { echo 'The backup directory and expected mount must already exist.' >&2; exit 1; }

destination_directory="$(readlink -f "$destination_directory")"
expected_mount="$(readlink -f "$expected_mount")"
actual_mount="$(findmnt --target "$destination_directory" --noheadings --output TARGET | xargs)"
[[ "$actual_mount" == "$expected_mount" ]] || { echo 'The backup destination is not mounted at the expected mount point.' >&2; exit 1; }

mapfile -t connection < <(node --env-file-if-exists="$environment_file" --input-type=module -e '
  const url = new URL(process.env.DATABASE_URL ?? "");
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!(["postgres:", "postgresql:"].includes(url.protocol)) || !localHosts.has(url.hostname) || !url.username || !database || !/^[A-Za-z0-9_-]+$/.test(database)) process.exit(1);
  process.stdout.write([url.hostname, url.port || "5432", decodeURIComponent(url.username), database].join("\n"));
') || { echo 'DATABASE_URL must target local PostgreSQL with a valid database name.' >&2; exit 1; }

[[ ${#connection[@]} -eq 4 ]] || { echo 'DATABASE_URL could not be read safely.' >&2; exit 1; }
export PGHOST="${connection[0]}" PGPORT="${connection[1]}" PGUSER="${connection[2]}"
database_name="${connection[3]}"
backup_path="$destination_directory/osleaders-$database_name-$(date -u +%Y-%m-%d-%H%M%S).dump"

pg_dump --format=custom --file="$backup_path" "$database_name"
[[ -s "$backup_path" ]] || { echo 'pg_dump did not create a non-empty backup file.' >&2; exit 1; }
pg_restore --list "$backup_path" >/dev/null

find "$destination_directory" -maxdepth 1 -type f -name "osleaders-$database_name-*.dump" -mtime +"$retention_days" -delete
echo "Created and verified PostgreSQL backup: $backup_path"
