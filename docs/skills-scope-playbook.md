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
  used to silently run the global body. That implicit path is removed; the
  migration (below) converts every such case into an explicit project skill so
  nothing breaks, and no new one can be created (Rule 4).

## Migration (one-time, data backfill)

`NNNN_skills_scope_explicit_backfill.sql` makes the existing data obey the new
rules without breaking any project that relied on the old fallback:

> For every `skill_registrations` row whose `skill_id` is a **global** skill and
> for which **no same-name `project` skill exists in that project**: clone the
> global into the project as a `project` skill (copy `name`, `description`,
> `skill_md`, `prompt`, `files`, `manifest`, `tools`, `content_hash`,
> `source='user'`), then repoint the registration's `skill_id` to the new
> project skill.

After the migration:
- Every registration points at a `project` skill (Rule 4 holds for existing data).
- Projects that used a global via fallback now own an explicit copy and keep
  working (including the Epodsystem `shop-*` stages).
- Globals revert to pure templates; unused ones can be pruned later as catalog
  cleanup (separate, deliberate step — not automatic).

The migration is idempotent: the `WHERE NOT EXISTS (same-name project skill)`
guard skips rows already converted.

## Operator notes

- **Adopt then register.** To wire a stage to a global template:
  `forge_skills.adopt {projectId, skillId: <globalId>}` → returns the new
  project skill → `forge_skills.register {projectId, skillId: <projectId>, stage}`.
  (A convenience `adopt_and_register` may wrap both, but the register primitive
  still only accepts project skills.)
- **Editing a global's behaviour for one project** = adopt + edit the project
  copy. The global is never edited in place (it is immutable).
- **forge-dev** is already compliant: all 8 stage skills are project-scoped, so
  the migration is a no-op for it.
