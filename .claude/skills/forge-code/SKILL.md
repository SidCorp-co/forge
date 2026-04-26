---
name: forge-code
description: "PROJECT-LOCAL OVERRIDE for jarvis-agents (Trunk-Based Development). Implements code changes, pushes ISS-* branch, ends at `developed`. forge-release merges to main after review pass."
user_invocable: true
arguments: "documentId1 documentId2 ..."
---

# Forge Code — jarvis-agents (TBD)

Project-local override. This repo runs **Trunk-Based Development**: single trunk `main`, short branches, feature flags hide incomplete work. See `<repo>/CLAUDE.md` § "Branching strategy".

## Project-specific defaults

### Git remote
Use `git remote | head -1` (this repo names it `github`, not `origin`):
```bash
REMOTE=$(git remote | head -1)
git push -u "$REMOTE" ISS-XX-short-title
```

### Deploy mode — TBD
- **No Coolify**, no preview URL, no auto-deploy
- Push ISS-* branch only at end of forge-code
- Status ends at `developed` — does NOT merge to main yet
- `forge-release` merges to main after review pass; `forge-staging` and `forge-test` are no-ops in this project

### Feature flag gate (mandatory for v1 epics)

Code merging to main behind incomplete features must be gated:

```ts
import { isEnabled } from '@/lib/feature-flags'; // forge/core
if (isEnabled('chatProvider')) {
  app.route('/api/chat', chatRoutes);
}
```

For v1 epics, the corresponding flag exists in `forge/core/src/lib/feature-flags.ts` (`chatProvider`, `runnerFramework`, `pipelineControl`, `commentMentions`, `userPreferences`, `knowledgeOps`, `webhookAdapter`). If your work is part of an epic, gate behind the right flag.

### Build / test (per-package)

| Affects files in | Build | Test |
|---|---|---|
| `forge/core/` | `cd forge/core && pnpm build` | `cd forge/core && pnpm test` |
| `forge/web/` | `cd forge/web && pnpm build` | `cd forge/web && pnpm test` |
| `forge/dev/` | `cd forge/dev && pnpm build` (skip Tauri unless required) | `cd forge/dev && pnpm test` |
| `forge/widget/` | `cd forge/widget && pnpm build` | `cd forge/widget && pnpm test` |
| `forge/contracts/` | `cd forge/contracts && pnpm build` | n/a |

Detect from `git diff --name-only` what packages changed. Build all affected packages.

**Pre-existing test failures** (don't block on these):
- `db/schema.test.ts` — `is_ceo` column drift
- 2 flaky route mocks (agent-sessions, chat-sessions)

If only these fail, proceed. If new failures appear, fix.

### Worktree mode (default ON)

This repo runs many parallel ISS-* sessions. **Default to worktree mode** unless main is provably idle:

```bash
git status -s            # any output = main is dirty
git worktree list        # >1 line = parallel session active
```

Either signal → use `.claude/worktrees/iss-XX-short-title/`:

```bash
git fetch "$(git remote | head -1)" main
git worktree add .claude/worktrees/iss-XX-short-title -b ISS-XX-short-title main
cd .claude/worktrees/iss-XX-short-title
```

All subsequent commands run in the worktree.

### Migration sequence collision

```bash
ls forge/core/drizzle/migrations/*.sql | sort | tail -5
```

Pick a number higher than any in-flight branch. If conflict at merge time, renumber the lower one.

### Commit style

Conventional with package scope: `feat(core):`, `fix(web):`, `refactor(dev):`. Body includes `Resolves ISS-XX`.

## Workflow (TBD)

1. Fetch issue + comments via `forge_issues → get` and `forge_comments → list`.
2. Detect collision (Step 4a in wrapper `references/workflow.md`); pick branch mode (clean) vs worktree mode (collision).
3. Setup workspace:
   - **Branch mode:** `git checkout main && git pull "$(git remote | head -1)" main && git checkout -b ISS-XX-short-title`
   - **Worktree mode:** `git worktree add .claude/worktrees/iss-XX-short-title -b ISS-XX-short-title main && cd .claude/worktrees/iss-XX-short-title`
4. Set status `in_progress`.
5. Implement per plan (gate new features behind flag if part of v1 epic).
6. Build affected package(s).
7. Run tests on affected package(s).
8. Self-review or launch review agent (per complexity from triage).
9. Fix any review findings; re-build + re-test.
10. Commit with Conventional + scope; reference `Resolves ISS-XX`.
11. Push ISS-* branch:
    ```bash
    git push -u "$(git remote | head -1)" ISS-XX-short-title
    ```
    **Do NOT** merge to main from forge-code. **Do NOT** call `forge_coolify_deploy` (project doesn't use Coolify).
12. Post comment summarizing the implementation (mention worktree path if applicable, mention the feature flag if gated).
13. Set status: `developed` (LAST action). `forge-release` will merge to main after independent review passes.

## Tools

- `forge_issues`, `forge_comments`
- ~~`forge_coolify_deploy`~~ — never used in this project
- Read, Edit, Write, Glob, Grep, Bash

## Output rules

Same as wrapper. Zero narration, code-only, one-line status, no recap.
