# OSLeaders agent instructions

Read `specs/00-product-spec.md` and `specs/01-architecture.md` before any
significant implementation work and before proposing changes to product
behaviour or architecture.

## Implementation progress

For every implementation task:

- Read `docs/implementation-status.md` before planning.
- Verify its statements against the checked-out repository and current Git
  history before relying on or changing it.
- Update it in the same pull request to reflect completed work, the current
  stage, the latest merged work, and the next recommended branch-sized task.
- Never mark work as completed unless it is implemented and merged.
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
- Review generated SQL migrations and Drizzle metadata before accepting them.
- Never use schema push. Only the guarded test reset command may clear database
  schemas, and it must never be aimed at development or production data.
- Add focused tests for new behaviour and relevant edge cases.
- Do not add a dependency unless the current stage needs it.
- Run `npm run check` and `git diff --check` before handing work back.
- Do not commit, push, deploy, or modify GitHub state unless explicitly asked.
