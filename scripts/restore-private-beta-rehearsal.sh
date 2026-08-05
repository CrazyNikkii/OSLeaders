#!/usr/bin/env bash
set -euo pipefail

project_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
environment_file="$project_directory/.env"
backup_path=""
rehearsal_database=""

usage() {
  echo "Usage: $0 --backup-path FILE --rehearsal-database NAME [--environment-file FILE] [--project-directory DIRECTORY]" >&2
  exit 2
}

while (($# > 0)); do
  case "$1" in
    --backup-path) backup_path="${2:-}"; shift 2 ;;
    --rehearsal-database) rehearsal_database="${2:-}"; shift 2 ;;
    --environment-file) environment_file="${2:-}"; shift 2 ;;
    --project-directory) project_directory="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ -f "$backup_path" && "$rehearsal_database" =~ ^[A-Za-z0-9_-]+$ ]] || usage

mapfile -t connection < <(node --env-file-if-exists="$environment_file" --input-type=module -e '
  const url = new URL(process.env.DATABASE_URL ?? "");
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!(["postgres:", "postgresql:"].includes(url.protocol)) || !localHosts.has(url.hostname) || !url.username || !database || !/^[A-Za-z0-9_-]+$/.test(database)) process.exit(1);
  process.stdout.write([url.hostname, url.port || "5432", decodeURIComponent(url.username), database].join("\n"));
') || { echo 'DATABASE_URL must target local PostgreSQL with a valid database name.' >&2; exit 1; }

[[ ${#connection[@]} -eq 4 ]] || { echo 'DATABASE_URL could not be read safely.' >&2; exit 1; }
runtime_database="${connection[3]}"
[[ "$rehearsal_database" != "$runtime_database" ]] || { echo 'The rehearsal database must not be the live configured database.' >&2; exit 1; }
export PGHOST="${connection[0]}" PGPORT="${connection[1]}" PGUSER="${connection[2]}"

pg_restore --list "$backup_path" >/dev/null
createdb --maintenance-db=postgres "$rehearsal_database"
pg_restore --no-owner --exit-on-error --dbname="$rehearsal_database" "$backup_path"
tables="$(psql --dbname="$rehearsal_database" --tuples-only --no-align --command="SELECT to_regclass('public.guilds'), to_regclass('public.daily_recap_runs');")"
[[ "$tables" == *"guilds|daily_recap_runs"* ]] || { echo 'The rehearsal restore did not contain the expected OSLeaders tables.' >&2; exit 1; }
echo "Restored and verified rehearsal database: $rehearsal_database"
