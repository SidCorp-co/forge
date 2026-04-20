# Skills

The units of agent work. Each skill is a prompt + tool allow-list that Claude Code executes when a job is dispatched.

## Overview

Jarvis Agents ships 8 built-in pipeline skills (`forge-triage`, `forge-clarify`, `forge-plan`, `forge-code`, `forge-review`, `forge-test`, `forge-release`, `forge-fix`). Users can also author custom skills and register them to pipeline stages — enabling domain-specific workflows without forking the product.

## Data Flow

```
  Built-in skills         User-authored skills
  (./.claude/skills/       (.claude/skills/ in project repo)
    oss-*, built-in)               │
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
| Built-in skill definitions | `.claude/skills/oss-*/SKILL.md` files in repo | Compiled at build time |
| User-authored skills | Project's `.claude/skills/` folder | Discovered on device during job execution |
| Skill metadata | frontmatter in SKILL.md | `name`, `description`, `tools`, registered stage |
| Skill invocation | `agents-jobs` dispatcher | Job payload includes `skillName` |

## Core Entities

### `Skill` (DB record)

| Field | Description |
|-------|-------------|
| `documentId` | Canonical ID |
| `name` | Globally unique identifier (e.g., `forge-triage`, `custom-deploy-sanity`) |
| `description` | What the skill does — shown in UI, used for routing |
| `scope` | `global` (built-in) \| `project` (user-authored) |
| `project` | Relation if scope is `project` |
| `registeredStage` | Which pipeline transition this skill handles (optional for non-pipeline skills) |
| `prompt` | The skill prompt body |
| `tools` | Allow-list of tools the skill can invoke |
| `version`, `hash` | For sync tracking |
| `evalScore` | Optional quality metric from Eval runs |

## Key Business Flows

### Using a built-in skill

1. Job enqueued with `skillName: 'forge-code'`
2. Dispatcher looks up skill by name (built-ins indexed at boot)
3. Payload built: prompt + tool allow-list + issue context
4. Device receives, runs `claude` with payload
5. JobEvents stream back

### Authoring a custom skill

1. User creates `.claude/skills/my-custom-skill/SKILL.md` in their project repo
2. On next project sync, device reads the file
3. Device POSTs `/api/projects/:id/skills/sync` with skill content + hash
4. Server persists `Skill` record with `scope: 'project'`
5. User registers it to a pipeline stage via **Project Settings → Pipeline**
6. Future jobs at that stage use the custom skill

### Skill updates

1. User edits `SKILL.md` locally
2. Next project sync detects content hash mismatch
3. Device POSTs update
4. Server updates skill record, bumps version
5. WebSocket broadcasts `skills:updated` to all clients connected to the project room

## API Endpoints

| Method | Endpoint | Principal | Description |
|--------|----------|-----------|-------------|
| `GET` | `/api/projects/:id/skills` | user / device | List project's skills (global + project-scoped) |
| `POST` | `/api/projects/:id/skills/sync` | device | Upsert a skill from local filesystem |
| `PUT` | `/api/projects/:id/skills/:skillId/register` | user | Register skill to a pipeline stage |
| `DELETE` | `/api/projects/:id/skills/:skillId` | user | Remove a project-scoped skill |

## Cross-Module Touchpoints

| Direction | Module | What | When |
|-----------|--------|------|------|
| Read by | [agents-jobs](../agents-jobs/README.md) | Skill definition | At dispatch time |
| Read by | [issues-pipeline](../issues-pipeline/README.md) | Skill → stage registration | When deciding what job to enqueue |
| Receives from | [devices](../devices/README.md) | Skill sync from local filesystem | On project bind, on file change |

## Built-in skills (v0.1 pipeline)

| Skill | Stage it maps to | Purpose |
|-------|------------------|---------|
| `forge-triage` | open → confirmed | Classify + priority set |
| `forge-clarify` | confirmed → clarified | Reproduce bugs, verify UX |
| `forge-plan` | clarified → approved | Write implementation plan |
| `forge-code` | approved → deploying | Implement + commit + push |
| `forge-review` | deploying → testing | Independent code review |
| `forge-test` | testing → staging | QA against preview deployment |
| `forge-release` | staging → released | Merge to production |
| `forge-fix` | reopen → deploying | Address rejection feedback |

## Future (v0.2+)

- Skill library UI: search, install, rate, version
- User-contributed marketplace
- Skill versioning + pinning per project
- Skill eval framework expansion
