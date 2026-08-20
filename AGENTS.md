# OSLeaders agent instructions

Read `specs/00-product-spec.md` and `specs/01-architecture.md` before any
significant implementation work and before proposing changes to product
behaviour or architecture.

## Implementation progress

For every implementation task:

- Read `docs/implementation-status.md` before planning.
- Verify its statements against the checked-out repository and current Git
  history before relying on or changing it.
- At the start of a new implementation chat, reconcile the status document
  with `master` and the recent merge history before selecting a task. Do not
  treat a merged branch as unmerged, recommend work that is already merged, or
  rely on a stale "latest merged" entry.
- Update it in the same pull request to reflect completed work, the current
  stage, the latest merged work, and the next recommended branch-sized task.
- Never mark work as completed unless it is implemented and merged.
- If a pull request's pre-merge status update becomes stale when it is merged,
  correct the merged record before starting the next implementation task.
- After finishing, recommend the next smallest sensible task.
- Ask the user when a real product decision is required; do not invent one.

Every independent review must also verify that
`docs/implementation-status.md` accurately reflects the repository and Git
history.

- The product specification is authoritative for user-visible behaviour.
- Follow the feature boundaries and dependency direction in the architecture.
- Keep each change within its approved implementation stage.
- Do not invent product rules; report specification conflicts before coding.
- Preserve strict isolation between Discord guilds in every guild-scoped feature
  and database operation.
- Keep core product rules independent of Discord, PostgreSQL, and network code.
- Preserve the zero-recurring-cost, low-resource architecture: one lightweight
  Node.js process plus local PostgreSQL.
- Do not introduce paid services, production Docker, Redis, queues, separate
  workers, or microservices without an approved architecture change.
- Never commit tokens, passwords, real connection strings, or populated `.env`
  files.
- When checking GitHub CLI authentication or performing GitHub CLI operations,
  use the elevated Windows credential context (`require_escalated`). Sandboxed
  `gh` commands cannot access the Windows keyring and may falsely report an
  invalid token.
- Review generated SQL migrations and Drizzle metadata before accepting them.
- Never use schema push. Only the guarded test reset command may clear database
  schemas, and it must never be aimed at development or production data.
- Add focused tests for new behaviour and relevant edge cases.
- Do not add a dependency unless the current stage needs it.
- Run `npm run check` and `git diff --check` before handing work back.
- Do not commit, push, deploy, or modify GitHub state unless explicitly asked.

## Private beta priority

The near-term product priority is to make OSLeaders safe and practical to run
continuously on the user's laptop for one private Discord server as soon as the
already implemented recap and read-only features can support it. This is an
early private beta, not a claim that the complete v1 feature set is finished.

- Prioritize the smallest operational-readiness work that enables the single
  configured server to use automatic daily recaps, account management, lookups,
  and leaderboards while competition and other v1 development continues.
- Keep the existing single-process Node.js plus local PostgreSQL architecture;
  do not introduce hosted services or production Docker for this goal.
- Before saying the bot is ready for this 24/7 private-beta use, verify and
  explicitly report the required laptop startup/restart path, PostgreSQL
  migration procedure, Discord command registration and
  permissions, and a successful real-server recap/restart acceptance checklist.
- Tell the user explicitly when that private-beta readiness point is reached.
