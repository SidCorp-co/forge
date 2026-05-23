---
name: forge-code
description: "PROJECT-LOCAL OVERRIDE for jarvis-agents (Trunk-Based Development). Implements code changes per the approved plan, builds + tests affected packages, gates new features behind feature flags when part of v1 epics, pushes ISS-* branch, ends at `developed`. forge-release merges to main after review pass."
user_invocable: true
arguments: "documentId1 documentId2 ..."
---

# Forge Code — jarvis-agents (TBD)

Project-local override. This repo runs **Trunk-Based Development**: single trunk (typically `main`, resolved via `branchConfig.baseBranch`), short branches, feature flags hide incomplete work. See `<repo>/CLAUDE.md` § "Branching strategy".

> **English-only output (non-negotiable)**: every byte written into the codebase MUST be in English regardless of issue language. UI strings, identifiers, comments, commit messages — all English. Translate any non-English wording from the issue/plan before implementing. See [`../README.md` § English-only rule](../README.md) for the rule and the ISS-43 incident that motivates it.

## Project-specific defaults

### Resolved branch config (mandatory preamble)

Before any git command, call `forge_config` to resolve which branches to use. Avoids hard-coding `main` so issues with non-default base (decomposed-epic integration branches, hotfix bases) work:

```ts
const cfg = await forge_config({ action: 'get', projectId, issueId: documentId });
const BASE = cfg.config.branchConfig.baseBranch;       // checkout source
const TARGET = cfg.config.branchConfig.targetBranch;   // merge destination (forge-release uses)
```

If `branchConfig` is absent (PR-A not yet rolled out for the project), fall back to `cfg.config.baseBranch` then to the literal `'main'`. Never write the literal `'main'` into a git command below — always interpolate `$BASE`.

### Git remote

```bash
REMOTE=$(git remote | head -1)    # this repo names it 'github', not 'origin'
git push -u "$REMOTE" ISS-XX-short-title
```

### Deploy mode — TBD

- No Coolify, no preview URL, no auto-deploy.
- Push ISS-* branch only at end of forge-code.
- Status ends at `developed` — does NOT merge to main yet.
- `forge-release` merges to main after review pass. `forge-staging` and `forge-test` are no-ops in this project.

### Feature flag gate (mandatory for v1 epics)

Code merging to main behind incomplete features must be gated:

```ts
import { isEnabled } from '@/lib/feature-flags';
if (isEnabled('chatProvider')) {
  app.route('/api/chat', chatRoutes);
}
```

v1 epic flags in `forge/core/src/lib/feature-flags.ts`: `chatProvider`, `runnerFramework`, `pipelineControl`, `commentMentions`, `userPreferences`, `knowledgeOps`, `webhookAdapter`. If your work is part of an epic, gate behind the right flag.

### Build / test (per-package)

| Affects files in | Build | Test |
|---|---|---|
| `forge/core/` | `cd forge/core && pnpm build` | `cd forge/core && pnpm test` |
| `forge/web/` | `cd forge/web && pnpm build` | `cd forge/web && pnpm test` |
| `forge/dev/` | `cd forge/dev && pnpm build` (skip Tauri unless required) | `cd forge/dev && pnpm test` |
| `forge/widget/` | `cd forge/widget && pnpm build` | `cd forge/widget && pnpm test` |
| `forge/contracts/` | `cd forge/contracts && pnpm build` | n/a |

Detect from `git diff --name-only` which packages changed; build/test only those.

**Pre-existing flakies (don't block on these):** `db/schema.test.ts` (`is_ceo` column drift), 2 flaky route mocks (agent-sessions, chat-sessions). If only these fail, proceed. New failures → fix.

### Worktree mode (default ON)

Default to worktree mode (`.claude/worktrees/iss-XX-short-title/`) unless main is provably idle. Detection + create commands: [references/worktree-mode.md](references/worktree-mode.md).

### Commit style

Conventional with package scope: `feat(core):`, `fix(web):`, `refactor(dev):`. Body includes `Resolves ISS-XX`.

## Workflow

1. `forge_issues → get` + `forge_comments → list` to load issue + plan.
2. Detect collision (worktree mode trigger — see [references/worktree-mode.md](references/worktree-mode.md)).
3. Setup workspace:
   - **Branch mode:** `git checkout "$BASE" && git pull "$REMOTE" "$BASE" && git checkout -b ISS-XX-short-title`
   - **Worktree mode:** `git worktree add .claude/worktrees/iss-XX-short-title -b ISS-XX-short-title "$BASE" && cd .claude/worktrees/iss-XX-short-title`
4. Set status `in_progress`.
5. Implement per plan (gate new features behind flag if part of v1 epic; translate any non-English UI text to English).
6. Build affected package(s).
7. Run tests on affected package(s).
8. Self-review or launch review agent (per complexity from triage).
9. Fix any review findings; re-build + re-test.
10. Commit with Conventional + scope; reference `Resolves ISS-XX`.
11. Push ISS-* branch: `git push -u "$REMOTE" ISS-XX-short-title`. Do NOT merge to main. Do NOT call `forge_coolify_deploy`.
12. Post a comment summarizing the implementation (mention worktree path if applicable, mention feature flag if gated).
13. Set status: `developed` (LAST action). `forge-release` will merge to main after independent review passes.

## References

- [references/worktree-mode.md](references/worktree-mode.md) — when to use, create, reuse, why worktrees and not branches, migration sequence collision.
- [../README.md § English-only rule](../README.md) — the full rule + ISS-43 incident.
