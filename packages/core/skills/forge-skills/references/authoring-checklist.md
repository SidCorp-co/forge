# Project skill — authoring checklist

Run this over a skill before shipping it.

## Altitude (NT1)
- [ ] Body says WHAT, not HOW — no hardcoded build/test/lint/dev commands (agent infers from the repo).
- [ ] No restating of preamble content (status ladder, enums, "status LAST", handoff schema, decompose, worktree).
- [ ] No hardcoded repoPath / base/production branch / test URLs — those come from config/bundle.
- [ ] **No secrets** anywhere in the body or references.

## Policy (the part that MUST be in the body)
- [ ] Non-inferable project policy is stated: gitflow/merge model, deploy gate, domain heuristics, any stage exit that overrides the default ladder.
- [ ] Per-project values that vary live in `projectFacts`, not the body.

## Token economy
- [ ] Decision logic / gates are INLINE.
- [ ] Long checklists / templates / playbooks are in `references/*.md` (lazy-loaded), referenced by a one-liner.
- [ ] Body isn't bloated (rough target: keep it focused; if a section is a lookup list, it's a reference).

## Mechanics & safety
- [ ] Exactly ONE merge mechanism (skill git-merge XOR server mergeStates) — no double-merge.
- [ ] Single-branch projects: release skips re-merge when already on production.
- [ ] `references` files created via MCP carry `encoding`.
- [ ] Status transition is the LAST action; comment is posted before it.

## Ship
- [ ] Read `forge_skills_effective` and reconciled against the live server body before overwriting.
- [ ] `forge_skills_update`/`create` (server) → `forge_skills_register` (stage, if new) → `forge_skills_push`.
- [ ] Verified ON DISK (`.claude/skills/<name>/SKILL.md`), not just the sync dashboard.
