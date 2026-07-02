# Skills scope — the explicit playbook

> Status: canonical. This file is the single source of truth for how a skill's
> **scope** decides whether it can run. It replaces the previous implicit
> behaviour (global-fallback + name-shadow dual path). If code and this doc
> disagree, the code is the bug.

## TL;DR

There are two scopes and **one** rule:

| scope | role | installed on a device? | dispatched in a pipeline? |
|-------|------|------------------------|---------------------------|
| `global`  | **org-level TEMPLATE** — a catalog entry you clone from | **never** | **never** |
| `project` | the **only usable skill** | yes (when registered) | yes (when registered) |

A `global` skill does **nothing** at runtime. To use one in a project you must
**adopt** it (clone it into the project as a `project` skill). After that, the
project owns its copy — editing the copy never touches the template, and the
template never "leaks" into the project's runtime.

There is exactly **one path** from "a skill exists" to "a skill runs":

```
global template ──adopt(clone)──▶ project skill ──register(stage)──▶ device sync ──▶ dispatch
                                       ▲
                       (or authored directly as a project skill)
```

## The rules (normative)

1. **Globals are templates only.** A `global` row is never installed, never
   registered, never dispatched. It exists to be listed in the catalog and
   cloned. (Globals stay immutable — `builtin` ones are re-seeded from disk.)

2. **Only project skills are usable.** Device sync manifest and pipeline
   dispatch resolve **`scope='project'` rows only**. There is no "if no project
   skill, fall back to the global" branch. None.

3. **Adoption is the only bridge.** `adopt(projectId, globalSkillId)` clones the
   global's body + files into a new `project` skill (same `name`,
   `scope='project'`, `projectId` set, `source='user'`). This is the only way a
   global's content enters a project. It is an explicit, user-initiated action.

4. **Registration requires a project skill.** `register(projectId, skillId,
   stage)` rejects any `skillId` that is not a `project` skill owned by that
   project (`error SKILL_NOT_PROJECT_SCOPED` → "adopt the template first").
   Registrations therefore always point at project skills.

5. **No name-shadow at runtime.** Because globals never resolve for use, there is
   no "project shadows same-name global" merge in the usable path. A project
   either *has* a project skill of a given name or it does not. (`shadowsGlobal`
   survives only as a catalog hint — see Rule 6 — never as a resolution rule.)

6. **Catalog vs usable are different reads, and named so:**
   - `resolveProjectSkills(projectId)` → **usable** set: project rows only. This
     is exactly what a device installs and what dispatch runs.
   - `resolveCatalogForProject(projectId)` → **browse/adopt** set: project rows
     (`usable: true`) + global templates (`usable: false`, `adoptedAsProject`
     flag when a same-name project skill already exists). This is what Skill
     Studio / `forge_skills.list` / `forge_skills.effective` show.

   `forge_skills.effective` no longer claims "exactly what a device installs" —
   that claim now belongs to the registered ∩ project subset only.

## What this fixes

- **Global noise with no effect.** Storefront `shop-*` globals (built for one
  project) used to appear in *every* project's effective list and were
  ambiguously "21 vs 8". Now they are clearly catalog templates with
  `usable:false` — they install/dispatch nowhere unless a project adopts them.
- **Silent fallback.** A stage registered against a global with no project copy
  used to silently run the global body. That implicit path is removed: the
  provisioning flows now materialise an explicit project skill up front (see
  below), and `registerSkillForProject` rejects a global outright (Rule 4), so no
  new global registration can be created.

## Provisioning materialises project skills (no migration)

There is **no data migration**. Instead the two provisioning flows materialise a
project-owned skill at the moment a stage is wired, via the shared bridge
`resolveOrAdoptProjectSkill(projectId, skillName)` (clone-on-first-use,
idempotent):

- **Project bootstrap** (`POST /projects/:id/skills/bootstrap`) — for each stage
  in `STATUS_TO_JOB_TYPE`, adopt the `forge-<type>` global template into the
  project and register the resulting **project** skill.
- **Domain-template apply** (`applyTemplate`) — for each `skillRegistrations`
  entry, adopt the named template into the project, then register the project
  skill. A name with no project/global match is skipped (warn-logged).

So every newly provisioned project ends up with project-owned skills and works
under the single path. Existing projects whose registrations still point at a
**global** (provisioned before this change) are intentionally **not**
backfilled: that stage resolves to no usable skill and the pipeline surfaces the
error rather than silently running the template — re-running bootstrap or
adopting the skill fixes it. (Accepted trade-off: "a project without a skill may
error.")

`forge_skills.adopt` remains the explicit, user-driven adopt for one-off cases;
`registerSkillForProject` stays strict (rejects a global with
`SKILL_NOT_PROJECT_SCOPED`) as the invariant guardrail behind both flows.

## Operator notes

- **Adopt then register.** To wire a stage to a global template:
  `forge_skills.adopt {projectId, skillId: <globalId>}` → returns the new
  project skill → `forge_skills.register {projectId, skillId: <projectId>, stage}`.
  (A convenience `adopt_and_register` may wrap both, but the register primitive
  still only accepts project skills.)
- **Editing a global's behaviour for one project** = adopt + edit the project
  copy. The global is never edited in place (it is immutable).
- **forge-dev** is already compliant: all 8 stage skills are project-scoped, so
  nothing changes for it.
- **Existing projects still bound to globals** (provisioned before this change)
  are not auto-fixed: re-run `POST /projects/:id/skills/bootstrap` (after
  clearing stale registrations) or adopt the needed skills. Until then those
  stages have no usable skill and error rather than silently run a template.

## Template-propagation protocol (ISS-605)

Every project copy is a fork frozen at adoption time — this protocol is how a
template improvement reaches existing projects. It runs on EVERY global bump
(the only bump path is `seedBuiltinSkills`; the CRUD route rejects globals):

| Step | What | Where |
|---|---|---|
| 0. Altitude gate | **A sentence that is true for every project is forbidden in a skill body** — it goes to the server-rendered layer (prompt facts / state-prompts / MCP descriptions), which propagates on deploy with zero sync. Only project-shaped content belongs in templates/copies. | authoring rule; `forge-skill-audit` flags violations |
| 1. Lineage stamp | Adoption records `based_on_global_skill_id` + `based_on_global_version` (migration 0145; pre-tracking copies backfilled with NULL version = treated as behind). | `createProjectSkill` via `applyGlobalSkillDefault` / `resolveOrAdoptProjectSkill` |
| 2. Drift surface | Catalog reads flag `behindTemplate` (+ `basedOnGlobalVersion` / `templateVersion`) on project rows adopted at an older or unknown version. | `effective.ts` dedup, `forge_skills.list` |
| 3. Rebase lane | Per behind-template project, the bump sweep drafts ONE idempotent `skill-rebase: <name> vX→vY` issue (**draft = human gate, never `open`**) instructing a three-way merge that preserves project deltas; ship via the existing explicit `skill.sync`. | `template-propagation.ts`, hooked in `builtin-seed.ts` |
| 4. No silent auto-push | Sync stays explicit (ISS-388). The sweep only creates draft issues. | — |

Long-term direction (delta-override composition — customize as delta over the
template so most rebases disappear): RFC
[0001-skill-delta-override](rfcs/0001-skill-delta-override.md).
