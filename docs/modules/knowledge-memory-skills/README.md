# Knowledge · Memory · Skills

**The context layer.** Four different things that must not be collapsed into one "AI memory" — each
answers a different question, and each has its own lifecycle.

```mermaid
flowchart TB
  SK[Skills<br/>how an agent works] --> EXEC([execution])
  MEM[Memory<br/>what was learned] --> EXEC
  KN[Project knowledge<br/>what this project is] --> EXEC
  EXEC --> EV[Evidence<br/>what actually happened]
  EV -.signals.-> CAND[memory_candidates<br/>accruing → graduated → accepted → promoted]
  CAND --> MEM
  SK -.global template.-> CLONE[project-owned clone] -.only this is dispatched.-> EXEC
```

| | Question it answers | Lifecycle |
|---|---|---|
| **Skills** | how does an agent do this kind of work? | authored, versioned, synced to devices |
| **Memory** | what has this project already learned? | accrued from signals, decayed, promoted |
| **Project knowledge** | what *is* this project? | authored per project, edited when the project changes |
| **Evidence** | what actually happened on this run? | written by execution, pruned — owned by [control-observability](../control-observability/) |

## What it owns

| Concern | Where it lives |
|---|---|
| Skill registry, scope, adoption | `core/src/skills/`, `schema.ts:skills`, `schema.ts:skillScopes` |
| Skill-authoring facts (`{{forge:}}` / `{{project:}}`) | `core/src/prompt/facts/registry.ts`, `core/src/skill-facts/`, `core/src/projects/project-facts.ts` |
| Prompt assembly per state | `core/src/prompt/`, `core/src/prompt/state-prompts/` |
| Guides served by slug from code | `core/src/guides/registry.ts` |
| Device-scoped plugin channel | `core/src/plugins/`, runner `workspace/plugin_sync.rs` |
| Semantic memory | `core/src/memory/`, `schema.ts:memories`, `schema.ts:memorySources` |
| Candidate accrual and promotion | `schema.ts:memoryCandidates`, `core/src/memory/candidates-*.ts` |
| Step handoffs between stages | `core/src/memory/step-handoff-schema.ts` |
| Project knowledge graph | `core/src/knowledge/`, `core/src/knowledge-edges/`, `schema.ts:knowledgeEntries` |
| Embeddings | `core/src/embeddings/`, `schema.ts:MEMORY_EMBEDDING_DIM` (1536) |
| Domain bootstrap templates | `core/src/domain-templates/` |
| UI | web `features/skills/`, `memory/`, `knowledge/`, `library/`, `skill-updates/` |

## Vocabulary

| Set | Values |
|---|---|
| `schema.ts:skillScopes` | `global` · `project` |
| `schema.ts:memorySources` | `issue` · `comment` · `job` · `note` · `knowledge` · `decision` · `policy` |
| `schema.ts:memoryCandidateSignalTypes` | `reopen_loop` · `repeated_fix_type` · `handoff_gap_rescue` · `agent_self_report` |
| `schema.ts:memoryCandidateStatuses` | `accruing` · `graduated` · `accepted` · `rejected` · `promoted` |
| `schema.ts:knowledgeKinds` | `overview` · `scenario` · `workflow` · `rule` · `guide` · `reference` · `glossary` |

## Guards

- **A global skill is never registered or dispatched.** `global` is a read-only template; choosing
  it for a stage materialises a project-owned clone and registers *that*. The `cm:guard` is on
  `core/src/skills/service.ts` and `core/src/skills/bootstrap-service.ts`.
- **Project facts land on disk.** `projectFacts` values are spliced verbatim into the
  device-installed `SKILL.md`, so they are never a place for secrets — test credentials live in the
  project's credential store.
- **Memory retrieval is hybrid.** `memories` carries both a pgvector embedding and a generated
  `tsvector`; the keyword strategy reads the latter via `@@` / `ts_rank`. The tsvector is a generated
  column — never written by the app.
