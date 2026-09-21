# One question, one answer

The data plane's target, replacing the one ISS-894 carried. Part of the
[destination set](index.html) — this round writes here and nowhere else, so nothing is filed into
a folder that will be forgotten. Measured 2026-09-20 against `main`
and the `forge-plugin` checkout at `3.35.311`.

## What changed, and why the old target is gone

ISS-894 (owner-decided 2026-09-01, closed 2026-09-06) set MCP's survivors as the **session-lifecycle
hooks** — `forge_step_start`, `forge_phase`, `forge_step_handoff.*` — with every data query moving
to REST. Waves 0–3 and 5 landed. Wave 4, the heavy block, never did: it was held by `mode: staged`
and by the plugin still calling `/mcp` over JSON-RPC. Both have since cleared — staged is gone, and
the plugin is REST-only at `3.35.311` — but the issue had already closed, so the remainder belongs
to nobody. The registry stood at 59 when it closed and stands at **60** today.

**That target is withdrawn, not merely unfinished.** It sorted tools by *what they do*
(lifecycle vs query). The new one sorts them by *who needs them to be fast*:

> **MCP exists so an AI agent reaches core natively and quickly.** Session-lifecycle plumbing does
> not need to be there — an agent driving an issue is already inside `issue-flow`, which sequences
> those calls. Reading and writing the record is what an agent reaches for constantly, so that is
> what belongs on the native surface.

The lifecycle tools cost almost nothing to drop, because REST already covers them:

| Tool | REST today | Cost of dropping |
|---|---|---|
| `forge_step_handoff.write` / `.get` / `.delete` | `/api/issue-step-contexts` — **1-to-1**, same service | none |
| `forge_phase` | `/api/pipeline-runs` + `pipeline/phase-routes.ts` | none |
| `forge_step_start` | **none — MCP-only** | a REST route first |
| `forge_uploads` | n/a | keep: it returns an image content block, which a CLI cannot hand a multimodal model |

## The rule that outranks the keep-list

**Where a capability exists on more than one surface, the surfaces must answer identically.**
Not "similarly", not "close enough after a mapping" — the same answer to the same question.

This is not aspirational. The tree already does it once, and says so in the source:

> `pipeline/step-handoff-routes.ts` — *"REST surface for step-handoff persistence. 1-to-1 with the
> `forge_step_handoff.*` MCP tools; both call the same service so behaviour is identical regardless
> of caller."*

And the tree already breaks it, in the busiest capability there is. Listing one project's issues:

| Surface | Code path | Filters |
|---|---|---|
| MCP `forge_issues` list | `issues/list-service.ts:listIssueRows` — MCP is its only caller | **11** |
| REST `GET /:id/issues` | conditions built inline in `issues/routes.ts` | **6** |
| CLI `forge issue` | goes to REST, inherits the 6 | 6 |

Three shared (`status`, `priority`, `category`). MCP alone has `search`, `label`, `module`,
`statusNot`, `complexity` and three date filters; REST alone has `assigneeId` and `key`. The CLI
verb and the MCP tool carry the same name and give different answers.

## The mechanism: make the keep-list data, not a decision

Deciding which tools survive is the wrong unit of work — it has to be re-decided every time the
product moves. Decide the mechanism once and the keep-list becomes a field.

1. **One capability per question, owned by its domain.** The capability holds the filters, the
   projection, the ordering and the pagination. No transport writes a filter of its own.
2. **Each capability declares which surfaces expose it** — `mcp`, `rest`, `cli` — as a flag.
   Adding or removing a tool from the native surface is then an edit to that flag, not a
   migration.
3. **The three surfaces are generated from it**, so parity is structural rather than tested.
   Where generation is impractical, a parity suite stands in: the plugin already declares **31
   pairs** of `MCP action → CLI invocation` in `plugin/src/resolve/visibility.mjs:VERBS[].wraps`,
   so the suite has its input and needs no new manifest. A pair that cannot be made equal is
   removed from the map by hand, with the reason written down — never left to differ in silence.
4. **Anything outside the agreed answer is deleted, not kept beside it.** This one rule survives
   from ISS-894 unchanged, and its wording there is the right wording: *"Xoá, không deprecate.
   Còn hai đường là còn hai đường."*

## What the keep-list looks like under the new rule

Not yet decided, and deliberately so — it is step 2's flag, not step 0's architecture. The shape
that follows from "native and fast for an agent" is roughly: read and write the record
(`forge_issues`, `forge_comments`), find things (`forge_memory_search`, `forge_knowledge`), read
project settings (`forge_config`), and `forge_uploads` for the transport reason above. Each of
those must pass the parity rule before it is exposed twice.

## Carried over from ISS-894, still true

- **`mcp_audit_log` is the authority on whether a tool is alive.** Grepping skill bodies was
  disproved by measurement there; do not reuse it. Count the whole table, no time window.
- **The live `skills` table is the half a repo grep cannot see.** Query it before deleting a tool.
- **Extract the shared service BEFORE writing the second surface.** The hand-written REST copy is
  exactly where an evidence gate was once forgotten.
- **A job-scoped token dies with its job, through `applyKernelTransition`.**
- **The PAT allowlist stays an allowlist**, never inverted to a deny-list.

## What was deleted to make room

`docs/architecture/` carried the withdrawn target in three files, now gone rather than annotated:
`agent-surface.md` (the shrinking-MCP target, and a fleet arrow describing plugin `3.35.140`),
`data-plane-surface.md` (which REST route replaces which MCP tool), and `system-overview.md`
(a second copy of the README figure whose core⇄runner arrow pointed the wrong way — the runner
dials out, `crates/forge-runner-core/src/transport/ws.rs:68`). Its `README.md` indexed the three.

ISS-894 and ISS-889 stay in the tracker. They record a decision that was genuinely made, and
deleting them would rewrite history rather than correct it; this document is the correction.

## Honest costs

| Cost | What it buys, and who pays |
|---|---|
| One registry is a refactor of every route and tool | Each capability's filters, projection, ordering and pagination leave its handler. Structural parity is the payoff; the bill is most of `mcp/tools/` and a large share of the route modules, with nothing user-visible to show |
| MCP loses hand-tuning | Several tools shape output for an agent's context budget in ways a REST client does not want. Those differences become declared projections or are given up, and some will be given up |
| The parity suite blocks merges | That is the point. A drifting pair stops a release until someone fixes it or removes the pair with a written reason. Teams who prefer the drift will feel this as friction, correctly |
| Dropping the lifecycle tools moves work to the plugin | `forge_step_handoff.*` and `forge_phase` have 1-to-1 REST routes so core pays nothing — but the plugin must change its calls on its own clock, and nothing here can gate that half |
| `forge_step_start` has no REST route | The one drop that needs a route built first. Until it exists the old surface stays |
