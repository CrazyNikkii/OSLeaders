# OSLeaders

OSLeaders is a Discord bot for small private Old School RuneScape communities.
The approved product requirements are in `specs/00-product-spec.md`, and the
approved technical design is in `specs/01-architecture.md`.

This repository contains the project and database foundations: centralized
runtime configuration validation, an initial guild tenancy-root schema,
reviewed SQL migrations, and PostgreSQL integration-test foundations. It does
not yet contain Discord connectivity, account registration, competitions,
recaps, leaderboards, or other product features.

## Prerequisites

Install these tools before working on the project:

- Node.js 24 LTS. The foundation was created with Node.js 24.18.0.
- npm 11. The foundation was created with npm 11.3.0.
- Git.

PostgreSQL 17 is required for database integration tests. The test database is
separate from development data and is safe to reset only through the guarded
test command described below.

Check the installed Node.js and npm versions in PowerShell:

```powershell
node --version
npm --version
```

## First-time setup

Open PowerShell in the repository folder and install the exact dependency
versions recorded in `package-lock.json`:

```powershell
npm ci
```

Create a private local environment file from the placeholder example:

```powershell
Copy-Item .env.example .env
Copy-Item .env.test.example .env.test
```

Use `.env` for normal development values and `.env.test` only for the local
test database. Replace their placeholders with your own private values. Never
commit either file or paste its secrets into an issue, pull request, or chat.

The runtime configuration loader accepts `NODE_ENV=development` or
`NODE_ENV=production` and the log levels `debug`, `info`, `warn`, or `error`.
It requires an explicit PostgreSQL database URL. The Discord application ID
must contain decimal digits only and remains a string so it cannot lose
precision. Shell and CI values take precedence over the optional local `.env`
file.

Before running database commands, open PowerShell and connect with PostgreSQL's
interactive client as the PostgreSQL administrator:

```powershell
psql -U postgres -d postgres
```

Enter the administrator password privately when prompted. Then run:

```sql
CREATE ROLE osleaders_dev LOGIN;
\password osleaders_dev
CREATE DATABASE osleaders_dev OWNER osleaders_dev;

CREATE ROLE osleaders_test LOGIN;
\password osleaders_test
CREATE DATABASE osleaders_test OWNER osleaders_test;
```

The `\password` command prompts privately; do not put either password in the
SQL window, command history, or chat.

## Available commands

| Command                                             | Purpose                                                        |
| --------------------------------------------------- | -------------------------------------------------------------- |
| `npm run format`                                    | Format supported project files with Prettier.                  |
| `npm run format:check`                              | Check formatting without changing files.                       |
| `npm run lint`                                      | Run ESLint and fail on warnings.                               |
| `npm run typecheck`                                 | Strictly type-check source code and tests.                     |
| `npm run db:generate -- --name NAME`                | Generate SQL migration files without connecting to PostgreSQL. |
| `npm run db:migrate`                                | Apply reviewed migrations to `osleaders_dev`.                  |
| `npm run db:test:reset -- --confirm osleaders_test` | Empty the guarded local test schemas only.                     |
| `npm run db:test:migrate`                           | Apply reviewed migrations to `osleaders_test`.                 |
| `npm run test:unit`                                 | Run tests that do not need PostgreSQL.                         |
| `npm run test:integration`                          | Reset, migrate, and test `osleaders_test`.                     |
| `npm run test`                                      | Run both unit and PostgreSQL integration tests.                |
| `npm run test:watch`                                | Re-run tests while files change.                               |
| `npm run build`                                     | Compile production source into `dist/`.                        |
| `npm run check:fast`                                | Run every check except PostgreSQL integration tests.           |
| `npm run check`                                     | Run every CI check, including PostgreSQL integration tests.    |

There is intentionally no `start` or `dev` command yet because bot login code is
outside the project-foundation stage.

`npm run db:test:reset` refuses to run unless `NODE_ENV` is exactly `test`, the
test URL names exactly `osleaders_test`, the host is local, the command includes
the confirmation shown above, and PostgreSQL reports that it is connected to
`osleaders_test`. It never uses `DATABASE_URL`.

## Before requesting review

Run:

```powershell
npm run check
git diff --check
git status --short
```

The approved specifications and generated `package-lock.json` are excluded from
incidental Prettier formatting.
