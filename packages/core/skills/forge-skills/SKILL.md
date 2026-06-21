---
name: forge-skills
description: "Meta-guide for Forge's per-project pipeline skills: what Forge does with a skill at runtime, and the standard for authoring / customizing / shadowing one correctly and cheaply. Read or invoke this BEFORE writing, rewriting, or tuning a project's skills — especially non-standard projects (MCP-driven build/deploy, docs-only, single-branch, local-only). Triggers on: /forge-skills, how do Forge skills work, customize skills for this project, author a skill, rewrite a skill, what does Forge do with skills."
user_invocable: true
arguments: "[skill-name]"
---

# Forge Skills — what they are & how to author them

A Forge **skill** is the instruction set an AI agent runs for one **pipeline stage** of one project (triage, clarify, plan, code, review, test, fix, release …). This meta-skill explains how Forge executes skills and the standard for writing/customizing them so they run correctly and don't waste tokens. Read it before touching a project's skills.

## 1. What Forge does with a skill (runtime model)

- **Pipeline = a status ladder.** Each stage **binds to exactly ONE skill** (`forge_skills_register`). A job at that stage loads **that one skill body** as its instructions — never all skills at once.
- **Per job the agent gets:** the bound skill body + a **shared preamble** (status ladder, complexity/priority enums, relation kinds, handoff schema, `branchConfig`, creds-as-pointer) that Forge injects and **prompt-caches** + a check-in bundle from `forge_step_start`. `references/*.md` load **only when the agent reads them** (lazy) — so they cost nothing until needed.
- **Scope & shadowing (ISS-388):** global skills are **read-only templates**. A project customizes one by creating a **same-name project skill**, which **shadows** the global for that project. There is no fork/override — just shadow-by-name. `forge_skills_effective` dedups by name (one row per name + `shadowsGlobal`).
- **Server-side + explicit sync:** skills live in the Forge cloud per project. Edit = `forge_skills_update` (server) → `forge_skills_push` (signals devices) → each device pulls and writes `.claude/skills/<name>/`. Nothing auto-syncs.

## 2. Decision tree — do you even need to touch a skill?

```
Need different pipeline behaviour for THIS project?
├─ A value that changes per project (branch, test URL, creds, a domain fact)?
│     → DON'T edit the skill. Put it in forge_config projectFacts / previewDeploy / branchConfig.
├─ The global stage skill is basically right, tweak the policy/heuristics?
│     → SHADOW it: create a same-name project skill (forge_skills_create), edit, register.
├─ A whole new capability/stage this project needs?
│     → New project skill + register it to a stage (or invoke standalone).
└─ It already works (most projects)?
      → Leave the global. Customisation is the exception, not the default.
```

## 3. Core authoring rules (NT1 — non-negotiable)

1. **Write WHAT, not HOW.** Intent altitude: *"build & test the affected packages, push only if green."* The agent infers the actual commands from the repo (package.json / Makefile / Cargo / lockfile). **Bad:** hardcode `npm run build`. **Good:** "build the affected package (infer the command from the repo)."
2. **Don't restate the preamble.** Status ladder, enums, "status LAST", handoff schema, decompose protocol, worktree rules are already injected every job. Restating them = drift when they change.
3. **Don't hardcode project config.** `repoPath`, base/production branch literals, test URLs, 🔒 credentials → come from the check-in bundle / `forge_config` / `previewDeploy` / `projectFacts`. **Never inline a secret** (it syncs to disk).
4. **Only write non-inferable POLICY** the agent can't derive from the repo: gitflow/merge model, deploy gate, stage exits that override the default ladder, domain heuristics, conventions.
5. **Token economy — put the right thing in the right place:**
   - **Inline (always-paid):** decision logic the agent must always see — gates, exit rules, "when to X vs Y".
   - **`references/*.md` (lazy):** long checklists, templates, playbooks, examples.
   - **`projectFacts` (preamble):** per-project values referenced by many skills.

## 4. Failure modes to avoid

1. Hardcoding mechanics (build/test/deploy commands) → breaks when the repo changes; violates rule 1.
2. Restating preamble content → silent drift.
3. **Double-merge:** the skill `git merge`s AND server `mergeStates` merges the same branch → empty-commit loop. Pick ONE merge mechanism.
4. **Files without `encoding`:** when adding `references` via MCP, set `encoding:"utf8"` (or base64) — a missing encoding can break the runner's skill sync.
5. Secrets inline; or putting a per-project value in the body instead of `projectFacts`.
6. Over-splitting: moving decision logic into a reference the agent may skip. Keep gates inline.

## 5. Authoring workflow (read → draft → ship → verify)

1. **Read what's live:** `forge_skills_effective` (catalog + which are shadowed) and the global body you're customizing. **Reconcile first** — the server may have diverged from any local copy.
2. **Draft** from `references/authoring-template.md`; run it through `references/authoring-checklist.md`.
3. **Ship server-first:** `forge_skills_update` (existing project skill) or `forge_skills_create` (new shadow). Then `forge_skills_register` to bind it to a stage if it isn't already.
4. **Sync + verify:** `forge_skills_push` → then **verify ON DISK** (`md5`/grep the marker in `.claude/skills/<name>/SKILL.md`). The WS sync-status dashboard is unreliable (false-negatives) — trust the disk.

## 6. Stage → skill quick reference (default pipeline)

| Status (stage) | Skill | Owns |
|---|---|---|
| open | forge-triage | completeness gate, complexity/category/priority |
| confirmed | forge-clarify | reproduce/validate, confidence gate |
| clarified | forge-plan | implementation plan, decompose decision |
| approved | forge-code | implement, build/test, simplify, push |
| developed | forge-review | independent 5-axis review (report-only) |
| testing | forge-test | QA against the deploy (functional + UX/a11y) |
| reopen | forge-fix | scoped fix from review/QA feedback + guard test |
| released | forge-release | merge-to-prod (guarded) + deploy + close |
| — (meta) | forge-skills · forge-skill-audit · forge-guidebook | author skills · audit pipeline quality · user docs |

## 7. Non-standard project patterns

- **MCP-driven build/deploy** (e.g. a storefront that publishes `{theme}.liquid` via a vendor MCP): "build/deploy" is **MCP tool calls, not a repo build**; the local dir is docs + code backup; git is for versioning/backup only. Write skills so: *implement* edits the source then **publishes via the vendor MCP**; *test* verifies on the **live service** (preview/theme URL), not localhost; *release* publishes + snapshots a backup. Keep **durable invariants** in the skill (backup-before-publish, verify-live, build-on-draft) and **defer tool mechanics** (tool names, traps) to the live vendor MCP playbook so they auto-track. Check whether a builtin family already fits (e.g. the `shop-*` Epodsystem skills) and **adopt/shadow those** rather than bending the git-centric defaults.
- **Single-branch (base==production):** forge-code merges the feature branch to that branch to deploy for testing; forge-release must **skip re-merging** (guard: already an ancestor) or it empty-commit-loops.
- **Docs-only / decision projects:** the deliverable is a committed markdown artifact; build/test is "the doc exists and is substantive", not a compile.
- **Local-only (no Coolify/preview):** the pipeline ends at `developed` for human review; test/release are skipped.

## Ship reminder

Edit the **server** first (`forge_skills_update`/`create`), **reconcile** before overwriting, **push**, then **verify on disk** — never hand-edit only the device copy and assume it stuck.
