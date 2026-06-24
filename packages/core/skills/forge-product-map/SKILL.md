---
name: forge-product-map
description: "Capture and maintain a project's product map — user journeys, scenarios, business rules, and workflow diagrams as curated Mermaid knowledge entries. Use this skill whenever someone wants to: document product flows, capture user journeys, generate scenario diagrams, maintain business rules visually, update the knowledge workspace, map user-facing routes, or bootstrap product documentation. Triggers on: /forge-product-map, capture product map, maintain user journeys, generate scenario flowcharts, document business rules, map product flows. IMPORTANT: This skill creates PRODUCT diagrams only — user journeys, UI routes, acceptance-criteria flows. It does NOT create architecture or codebase diagrams (no file paths, function names, or implementation details)."
user_invocable: true
arguments: "[bootstrap|refresh|gap] [projectId|scenarioName]"
---

# forge-product-map

Maintains a project's curated product knowledge as Mermaid visual entries. Writes `overview`, `scenario`, `workflow`, and `rule` entries via `forge_knowledge action=upsert`. All diagrams represent **user-facing product behaviour** — never internal implementation.

## Modes

- **bootstrap** (default) — full sweep: read existing entries, read shipped issues for evidence, identify gaps, ask the human only for gaps that cannot be inferred. Write/refresh all entry kinds.
- **refresh** — incremental: read recently closed/released issues since the last run, update existing entries that those issues affect, add missing scenarios.
- **gap [scenarioName]** — produce or fill exactly ONE scenario entry. Ask the human for the scenario name if not provided.

## Hard verification gate (AC5 — non-negotiable)

Before writing ANY node into a scenario or workflow diagram:

1. Every node must map to one of: a real issue id, an acceptance criterion phrase, or a user-facing route string (e.g. `/projects/:slug/library`).
2. **NO** `file:line`, function names, module names, or source-code identifiers as nodes. If a node names a file or function, DELETE it — replace with the user-facing action it implements.
3. Tag each entry:
   - `confidence: "verified"` when a shipped (closed/released) issue directly backs the node.
   - `confidence: "inferred"` when derived from comments, ACs, or reasonable inference.
4. Store backing issue ids in `metadata.relatedIssueIds: string[]`.

Violating this gate produces diagrams that rot when the code changes. Product diagrams must survive a complete rewrite of the implementation.

## Source priority

Read sources in this order; later sources are used only when earlier ones are insufficient:

1. **Existing knowledge entries** — `forge_knowledge action=list` (then `action=get` for full bodies). These are already curated; update rather than replace.
2. **Shipped issues** — `forge_issues action=list` with `status=closed` or `status=released`. Read `acceptanceCriteria`, `description`, and comments for evidence of real user flows.
3. **Semantic search** — `forge_knowledge action=search scope=all query="<topic>"` for context not in the entry list.
4. **The human** — ask ONLY for gaps that none of the above sources can fill. Batch all gap questions into a single message.

## Entry kinds and Mermaid syntax

| Kind | Mermaid syntax | Description |
|---|---|---|
| `overview` | `mindmap` | One per project. Root = product name. Branches = major feature areas. Leaves = key user capabilities. |
| `scenario` | `flowchart LR` or `flowchart TD` | One per user journey (e.g. "Issue triage flow", "Runner pairing flow"). Nodes = user-facing steps. |
| `workflow` | `stateDiagram-v2` | One per entity lifecycle (e.g. "Issue status lifecycle"). States = status values; transitions = events. |
| `rule` | plain Markdown | Business rules and constraints that agents must follow. No Mermaid. |

Each entry body is a Markdown document containing:
- A fenced `mermaid` code block (for overview/scenario/workflow)
- A brief prose paragraph before the diagram describing what it shows
- For scenario/workflow: a bullet list of backing issue ids after the diagram

## Workflow

### bootstrap mode

1. `forge_knowledge action=list projectId=<id>` — read all existing entries.
2. `forge_issues action=list projectId=<id> status=released` and `status=closed` — read shipped issues (up to 50, newest first). For each, read `acceptanceCriteria` + comments to extract user flows.
3. Build a map: feature area → user journeys → nodes. Apply verification gate.
4. Identify gaps (feature areas with no scenario entry, unclear workflows).
5. If gaps remain, ask the human: "I found the following gaps I can't infer from shipped issues: [list]. Can you describe [gap1]? [gap2]?" — batch all questions.
6. Write entries:
   - `overview` mindmap (upsert slug `product-overview`)
   - One `scenario` per identified user journey (slug: kebab of journey name, e.g. `issue-triage-flow`)
   - `workflow` stateDiagram for entity lifecycles (slug: `<entity>-lifecycle`)
   - `rule` entries for discovered business constraints
7. Set `authoredBy: "agent"` on all written entries.

### refresh mode

1. Read existing entries (`forge_knowledge action=list`).
2. Read issues closed/released since last entry `updatedAt` (approximate: last 30 days).
3. For changed feature areas: update the relevant scenario/workflow entries.
4. Upsert only changed entries. Log which were updated vs unchanged.

### gap mode

1. If `scenarioName` arg provided, proceed. Otherwise ask: "Which user journey should I document?"
2. Read related issues and existing entries for context.
3. Write ONE `scenario` entry for the named journey.
4. Apply verification gate before writing.

## Output format for each entry body

```markdown
<One sentence describing what this diagram shows.>

\`\`\`mermaid
<diagram code here — no click handlers, no HTML labels>
\`\`\`

**Backing evidence:**
- ISS-XXX: <AC phrase that maps to a node>
- ISS-YYY: <route or feature that maps to a node>
```

## Out of scope (P4)

- Lifecycle hooks to auto-run at release or on a schedule — those are P4.
- Automatic trigger on issue close — manual + bootstrap-wizard only in P2.

## Common mistakes to avoid

- Never add a `click` directive to Mermaid nodes (breaks `securityLevel:strict`).
- Never use HTML labels (`<b>`, `<br/>`) in Mermaid nodes (blocked by `securityLevel:strict`).
- Never create a node whose label is a file path, function name, or line number.
- Never overwrite a `confidence:verified` entry with `confidence:inferred` — only upgrade, never downgrade.
- If upsert returns `degraded:true`, log it but continue — the entry is stored (embedding will be backfilled).
