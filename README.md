# OSLeaders

OSLeaders is a Discord bot for small private Old School RuneScape communities.
The approved product requirements are in `specs/00-product-spec.md`, and the
approved technical design is in `specs/01-architecture.md`.

This repository currently contains the project foundation only. It does not yet
contain a runnable Discord bot, database schema, or product features.

## Prerequisites

Install these tools before working on the project:

- Node.js 24 LTS. The foundation was created with Node.js 24.18.0.
- npm 11. The foundation was created with npm 11.3.0.
- Git.

PostgreSQL 17 is installed for later stages, but this foundation does not
connect to it or require it for tests.

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
```

Replace the placeholders in `.env` with development-only values when a later
stage introduces configuration loading. Never commit `.env` or paste its
secrets into an issue, pull request, or chat.

## Available commands

| Command                | Purpose                                       |
| ---------------------- | --------------------------------------------- |
| `npm run format`       | Format supported project files with Prettier. |
| `npm run format:check` | Check formatting without changing files.      |
| `npm run lint`         | Run ESLint and fail on warnings.              |
| `npm run typecheck`    | Strictly type-check source code and tests.    |
| `npm run test`         | Run the unit tests once.                      |
| `npm run test:watch`   | Re-run tests while files change.              |
| `npm run build`        | Compile production source into `dist/`.       |
| `npm run check`        | Run every CI code-quality check locally.      |

There is intentionally no `start` or `dev` command yet because bot login code is
outside the project-foundation stage.

## Before requesting review

Run:

```powershell
npm run check
git diff --check
git status --short
```

The approved specifications and generated `package-lock.json` are excluded from
incidental Prettier formatting.
