# Project skill — authoring checklist

Run this over a skill before shipping it.

## Altitude (NT1)
- [ ] Body says WHAT, not HOW — no hardcoded build/test/lint/dev commands (agent infers from the repo).
- [ ] No restating of preamble content (status vocabulary, enums, "status LAST", handoff schema, worktree).
- [ ] No hardcoded project config (SKILL.md rule 3).
- [ ] **No secrets** anywhere in the body or references.

## Policy (the part that MUST be in the body)
- [ ] Non-inferable project policy is stated: gitflow/merge model, deploy gate, domain heuristics.
- [ ] Per-project values that vary live in knowledge entries, not the body.

## Token economy
- [ ] Decision logic / gates are INLINE.
- [ ] Long checklists / templates / playbooks are in `references/*.md` (lazy-loaded), referenced by a one-liner.
- [ ] Body isn't bloated (rough target: keep it focused; if a section is a lookup list, it's a reference).

## Mechanics & safety
- [ ] Exactly ONE merge mechanism (skill git-merge XOR server mergeStates) — no double-merge.
- [ ] Single-branch projects: release skips re-merge when already on production.
- [ ] `references` files (`files[]`) carry `encoding`.
- [ ] Status transition is the LAST action; comment is posted before it.

## Ship
- [ ] Read `GET /api/projects/:projectId/skills/effective` and reconciled against the live server body before overwriting.
- [ ] `PUT`/`POST /api/skills` (server, `installOnly: true` on the `PUT`) → `POST /api/skills/bulk-push`.
- [ ] Verified ON DISK (`.claude/skills/<name>/SKILL.md`), not just the sync dashboard.
