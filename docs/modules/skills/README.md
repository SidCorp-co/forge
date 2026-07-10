# Skills

Units of agent work: each skill is a prompt + tool allow-list Claude Code runs when a job is dispatched.

- 8 built-in pipeline skills (`forge-triage`, `forge-clarify`, `forge-plan`, `forge-code`, `forge-review`, `forge-test`, `forge-release`, `forge-fix`).
- Users author custom skills + register them to pipeline stages — domain workflows without forking.

## Data Flow

```
  Built-in skills         User-authored skills
  (packages/core/skills/   (.claude/skills/ in project repo)
    forge-*, seeded on boot)       │
           │                        │
           └────────┬───────────────┘
                    ▼
          ┌──────────────────┐
          │ Skill registry    │ (in-memory + DB cache)
          │ per project       │
          └────────┬─────────┘
                   │ lookup by name
                   ▼
          ┌──────────────────┐
          │ Job dispatch     │ (see agents-jobs)
          │ builds payload:  │
          │ { skillName,     │
          │   prompt,        │
          │   tools[],       │
          │   args }         │
          └────────┬─────────┘
                   ▼
           Sent to device for execution
```

### Input Sources

| Data | Source | Notes |
|------|--------|-------|
| Built-in skill definitions | `packages/core/skills/forge-*/SKILL.md` (prefix `BUILTIN_SKILL_PREFIXES=['forge-']`) | Seeded server-side on boot (`seedBuiltinSkills`), not compiled from `.claude/skills` |
| User-authored skills | Project's `.claude/skills/` folder | Discovered on device during job execution |
| Skill metadata | frontmatter in SKILL.md | `name`, `description`, `tools`, registered stage |
| Skill invocation | `agents-jobs` dispatcher | Job payload includes `skillName` |

## Core Entities

### `Skill` (DB record)

| Field | Description |
|-------|-------------|
| `id` | Canonical UUID |
| `name` | Unique per scope (`(name) WHERE scope='global'`, `(project_id, name) WHERE scope='project'`) |
| `description` | What the skill does — shown in UI, used for routing |
| `scope` | `global` (built-in) \| `project` (user-authored) |
| `projectId` | FK to `projects.id`; NULL when `scope='global'` |
| `source` | `builtin` (shipped with server) \| `user` (synced from device) |
| `prompt` | The skill prompt body (SKILL.md body after frontmatter) |
| `tools` | Allow-list of tools the skill can invoke (jsonb) |
| `manifest` | Parsed frontmatter (`user_invocable`, `arguments`, …) as jsonb |
| `version`, `contentHash` | For sync tracking — seeder bumps `version` when `contentHash` changes |
| `evalScore` | Optional quality metric from Eval runs |

### `SkillRegistration` (DB record)

Binds one skill to a pipeline stage **per project**; same skill can map to different stages across projects.

| Field | Description |
|-------|-------------|
| `id` | Canonical UUID |
| `projectId` | FK to `projects.id` |
| `skillId` | FK to `skills.id` |
| `stage` | Pipeline transition key (e.g. `open→confirmed`, `confirmed→clarified`) |
| `registeredBy` | User who registered (FK to `users.id`, SET NULL on delete) |
| `createdAt` | Registration timestamp |

Unique constraint: `(projectId, stage)` — at most one skill per stage per project.

## Key Business Flows

- **Using a built-in skill**: job enqueued `skillName: 'forge-code'` → dispatcher looks up by name (built-ins indexed at boot) → payload (prompt + tool allow-list + issue context) → device runs `claude` → JobEvents stream back.
- **Authoring a custom skill**: user creates `.claude/skills/my-custom-skill/SKILL.md` in repo → next project sync, device reads file → device POSTs `/api/projects/:id/skills/sync` (content + hash) → server persists `Skill` `scope: 'project'` → user registers to stage via **Project Settings → Pipeline** → future jobs at that stage use it.
- **Skill updates**: user edits `SKILL.md` locally → next sync detects content hash mismatch → device POSTs update → server updates record, bumps version → WebSocket broadcasts `skills:updated` to all clients in the project room.

## API Endpoints

| Method | Endpoint | Principal | Description |
|--------|----------|-----------|-------------|
| `GET` | `/api/projects/:id/skills` | user / device | List project's skills (global + project-scoped) |
| `POST` | `/api/projects/:id/skills/sync` | device | Upsert a skill from local filesystem |
| `POST` | `/api/projects/:id/skills/:skillId/register` | user | Register skill to a pipeline stage |
| `DELETE` | `/api/projects/:id/skills/:skillId` | user | Remove a project-scoped skill |

## Cross-Module Touchpoints

| Direction | Module | What | When |
|-----------|--------|------|------|
| Read by | [agents-jobs](../agents-jobs/README.md) | Skill definition | At dispatch time |
| Read by | [issues-pipeline](../issues-pipeline/README.md) | Skill → stage registration | When deciding what job to enqueue |
| Receives from | [devices](../devices/README.md) | Skill sync from local filesystem | On project bind, on file change |

## Built-in skills (v0.1 pipeline)

| Skill | Trigger → exit status | Purpose |
|-------|-----------------------|---------|
| `forge-triage` | `open` → `confirmed` / `needs_info` | Validate completeness, classify complexity, detect relations, set category/priority |
| `forge-clarify` | `confirmed` → `clarified` / `needs_info` | Reproduce bug / validate UX in live env, evidence + root-cause hypothesis |
| `forge-plan` | `clarified` → `approved` (S/M) / `waiting` (C) | Explore code, write implementation plan + QA scenarios |
| `forge-code` | `approved` → `developed` | Implement, build, tiered review, commit, push ISS-* branch |
| `forge-review` | `developed` → `testing` / `reopen` | Independent fresh-context code review + diff smoke |
| `forge-test` | `testing` → `tested` (manual release gate) / `reopen` | Merge ISS-* + Coolify deploy beta + full live E2E gate (does not merge to production) |
| `forge-release` | `released` → `closed` | Append release note, delete branch, close (does NOT merge) |
| `forge-fix` | `reopen` → `developed` | Scoped fix on ISS-* branch |

## Scope & shadowing (ISS-388)

Global skills are **read-only default templates**; a project customizes one by creating a **same-name project skill that SHADOWS** the global for that project. There is no fork/override mechanism.

- MCP + Skill Studio create/update/delete **per-project** skills only — global is never mutated.
- `skills/effective.ts` dedups by name (**project wins**) → one row per name plus a `shadowsGlobal` marker; `forge_skills.list`/`effective` surface it.
- **Removed**: `forge_skills.override_set`/`override_delete`, REST `override-routes.ts`, the `projectSkillOverrides` table, and the override-merge `isOverridden` branch. Shadow-by-name only.

## Skill delivery: stage (disk) vs meta (MCP-served)

Two distinct delivery channels — do not conflate them:

| Channel | Skills | How delivered | Disk sync / device status? | Bound to a stage? |
|---------|--------|---------------|----------------------------|-------------------|
| **Stage** (disk) | the registered pipeline + custom skills | runner pulls `resolveRegisteredEffectiveSkills` (registered project-scoped skills only) → `.claude/skills` | yes — deterministic, shadowable, has per-device sync-status | yes |
| **Meta** (MCP-served) | `forge-skills` and any other `MANAGED_META_SKILLS` | served LIVE as MCP **prompts** from the Forge MCP server — zero disk, always-latest | **no** — never installed to disk, no device sync-status | no (user-invocable) |

- `MANAGED_META_SKILLS` (`packages/core/src/skills/effective.ts`) is the list of meta-skill names; add a name there to serve a new meta builtin everywhere.
- `resolveManagedMetaPrompts(projectId)` resolves each meta skill's body per project (a project-adopted copy wins over the global template; `null` projectId → global).
- Forge MCP server (`packages/core/src/mcp/server.ts`) advertises the `prompts: {}` capability and answers `ListPrompts`/`GetPrompt`, project-scoped via the `X-Forge-Project-Slug` header.
- The meta disk-install path (with a `pipelineConfig.syncManagedSkills` opt-out) was added then **removed** — MCP-serve replaced it. `syncManagedSkills` no longer exists; do **not** reintroduce it.
- `GET /api/skills` tags each row with `managedMeta` (computed from `MANAGED_META_SKILLS`, by name) so the **Skill Studio** UI renders meta skills as MCP-served (no sync-status, no stage-registration), with a source label of *Platform default* (global) vs *Project-adopted* (a same-name project copy exists).

## Future (v0.2+)

- Skill library UI: search, install, rate, version
- User-contributed marketplace
- Skill versioning + pinning per project
- Skill eval framework expansion
