# OSLeaders agent instructions

Read `specs/00-product-spec.md` and `specs/01-architecture.md` before any
significant implementation work and before proposing changes to product
behaviour or architecture.

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
- Add focused tests for new behaviour and relevant edge cases.
- Do not add a dependency unless the current stage needs it.
- Run `npm run check` and `git diff --check` before handing work back.
- Do not commit, push, deploy, or modify GitHub state unless explicitly asked.
