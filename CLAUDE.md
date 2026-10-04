# CLAUDE.md — Instructions for Claude Code

## Core Rules

1. **Read documentation first** — Before implementing, read relevant docs in `docs/`, `contracts/`, `team/TEAM.md`, and `CONTRIBUTING.md`.

2. **Documentation and contracts are source of truth** — Do not invent requirements, APIs, schemas, or architecture. Follow what is documented.

3. **No architecture changes without approval** — Do not add Kafka, new services, databases, frameworks, or infrastructure without explicit team agreement.

4. **Keep it simple** — Avoid overengineering. Implement the minimal viable solution for the current phase.

5. **Respect ownership boundaries** — 
   - `services/gateway/` → Member 1 (Vedant)
   - `services/worker/` → Member 3 (Atharva)
   - `frontend/` → Member 2 (Om)
   - `deploy/` → Member 3 (Atharva)
   - `contracts/`, `docs/`, `team/` → All members

6. **Scope changes to the task** — Don't refactor unrelated code or add features not requested.

7. **Verify with tests/builds** — When implementation exists, run lint, typecheck, and tests before considering work complete.

8. **Security** — Never commit secrets, API keys, passwords, or tokens. Don't expose secrets in logs.

9. **Ask before destructive or architecture-changing operations** — If unsure, ask the team.

10. **Update documentation** — When an approved architectural or contract change occurs, update the relevant docs in the same PR.

11. **Follow CONTRIBUTING.md** — Use the Git/branch/PR workflow defined there.

## Quick Reference

| Document | Purpose |
|----------|---------|
| `docs/PRD.md` | What we're building and why |
| `docs/ARCHITECTURE.md` | How the system works |
| `docs/PHASES.md` | Implementation order and dependencies |
| `team/TEAM.md` | Who owns what |
| `contracts/` | Shared interfaces (API, events, DB, Redis) |
| `CONTRIBUTING.md` | Git workflow and team rules |