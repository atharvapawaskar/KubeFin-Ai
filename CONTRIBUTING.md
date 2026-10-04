# CONTRIBUTING.md — Team Git/GitHub Workflow

## Branch Strategy

- **main** is the shared integration branch. No direct pushes.
- All work happens on **short-lived task branches** cut from main.
- Branch naming: `<member>/<area>-<description>`
  - Examples: `m1/gateway-auth`, `m2/dashboard-spend`, `m3/worker-cost-calc`
- Branch lifetime: 1–3 days. If longer, split the work.

## Pull Requests

- Open PR against main when ready for review.
- PR must pass CI before merge.
- At least one review from a team member not owning the code.
- **Contract changes** (anything in `contracts/`) require review from **all affected members**.
- **Breaking contract changes** require explicit team agreement before merging.
- Squash merge preferred. Delete branch after merge.
- Keep PRs focused — one logical change per PR.

## Commit Hygiene

- No secrets, API keys, passwords, or tokens in commits.
- Use `.env.example` for placeholder configuration.
- Meaningful commit messages (conventional commits encouraged).

## Documentation Updates

When behavior, architecture, or contracts change:
- Update relevant docs in the same PR
- `docs/ARCHITECTURE.md` for system changes
- `contracts/` for interface changes
- `docs/PHASES.md` if phase dependencies shift

## Local Development

```bash
cp .env.example .env
docker compose up -d   # starts MongoDB + Redis
```

## Escalation

- Disagreements on architecture/contracts → discuss in PR, escalate to team sync
- Blocking issues → tag relevant member, pair if needed