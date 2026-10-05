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
to nobody. The registry stood at 59 when it closed; the 2026-10-04 cut below took it to **9**.

**That target is withdrawn, not merely unfinished.** It sorted tools by *what they do*
(lifecycle vs query). The new one sorts them by *who needs them to be fast*:

> **MCP exists so an AI agent reaches core natively and quickly.** Session-lifecycle plumbing does
> not need to be there — an agent driving an issue is already inside `issue-flow`, which sequences
> those calls.

The lifecycle tools cost almost nothing to drop, because REST already covers them:

| Tool (now dropped) | REST that serves it | Cost of dropping |
|---|---|---|
| `forge_step_handoff.write` / `.get` / `.delete` | `/api/issue-step-contexts` — **1-to-1**, same service | none |
| `forge_phase` | `/api/pipeline-runs` + `pipeline/phase-routes.ts` | none |
| `forge_step_start` | none as one call: its bundle is `GET /api/issues/:id`, `/comments`, `/api/issue-step-contexts` and `GET /api/projects/:id` read separately | dropped |
| `forge_uploads` | n/a | kept, fetch only: it returns an image content block, which a CLI cannot hand a multimodal model |

## The rule that outranks the keep-list

**Where a capability exists on more than one surface, the surfaces must answer identically.**
Not "similarly", not "close enough after a mapping" — the same answer to the same question.

This is not aspirational. The tree did it once, and says so in the source:
`pipeline/step-handoff-routes.ts` is the REST surface for step-handoff persistence "over the one
service in `./issue-context-store.ts`".

The busiest capability now keeps it, all but two names. Listing one project's issues,
`GET /:id/issues` and `GET /:id/issues/search` both read `issues/list-service.ts:listIssues` and
take one filter set (`issues/request-schemas.ts:issueListFilterFields`); the CLI `forge issue` goes
to REST and inherits it. The two names still differ: the text filter is `search` on the list and
`q` on search, the assignee `assigneeId` on the list and `assignee` on search.

## The mechanism: make the keep-list data, not a decision

Deciding which tools survive is the wrong unit of work — it has to be re-decided every time the
product moves. Decide the mechanism once and the keep-list becomes a field.

1. **One capability per question, owned by its domain.** The capability holds the filters, the
   projection, the ordering and the pagination. No transport writes a filter of its own.
2. **Each capability declares which surfaces expose it** — `mcp`, `rest`, `cli` — as a flag.
   Adding or removing a tool from the native surface is then an edit to that flag, not a
   migration.
3. **The three surfaces are generated from it**, so parity is structural rather than tested.
   Where generation is impractical, a parity suite stands in. A pair that cannot be made equal is
   removed from the map by hand, with the reason written down — never left to differ in silence.
4. **Anything outside the agreed answer is deleted, not kept beside it.** This one rule survives
   from ISS-894 unchanged, and its wording there is the right wording: *"Xoá, không deprecate.
   Còn hai đường là còn hai đường."*

## What the keep-list is

Owner rule, 2026-10-04: the REST API is the primary door and the CLI sits on it; MCP keeps only
the tools an agent needs that neither covers. The registry holds 8: `forge_uploads` (fetch, for the
transport reason above), the core-mediated integrations whose credential stays in core —
`forge_source`, `forge_coolify_deploy`, `forge_sentry`, `forge_storefront_target` — and three with
REST twins, `forge_agent_report` (`/api/agent-reports`), `forge_channel` and `forge_ecosystem`
(`/api/projects/:id/channel|interface|links|builder-runs`; only `forge_ecosystem action=context` has
no route). No prompt in this repository names those three; they stay while the forge-plugin skills
call them. Reading and writing the record, memory, knowledge and project settings are REST.

## Carried over from ISS-894, still true

- **`mcp_audit_log` is the authority on whether a tool is alive.** Grepping skill bodies was
  disproved by measurement there; do not reuse it. Count the whole table, no time window.
- **The live `skills` table is the half a repo grep cannot see.** Query it before deleting a tool.
- **Extract the shared service BEFORE writing the second surface.** The hand-written REST copy is
  exactly where an evidence gate was once forgotten.
- **The PAT allowlist stays an allowlist**, never inverted to a deny-list.

## What was deleted to make room

`docs/architecture/` carried the withdrawn target in three files, now gone rather than annotated:
`agent-surface.md` (the shrinking-MCP target, and a fleet arrow describing plugin `3.35.140`),
`data-plane-surface.md` (which REST route replaces which MCP tool), and `system-overview.md`
(a second copy of the README figure whose core⇄runner arrow pointed the wrong way — the runner
dials out, `crates/runner-transport/src/ws.rs`). Its `README.md` indexed the three.

ISS-894 and ISS-889 stay in the tracker. They record a decision that was genuinely made, and
deleting them would rewrite history rather than correct it; this document is the correction.

## Honest costs

| Cost | What it buys, and who pays |
|---|---|
| One registry is a refactor of every route and tool | Each capability's filters, projection, ordering and pagination leave its handler. Structural parity is the payoff; the bill is most of the tools and a large share of the route modules, with nothing user-visible to show |
| MCP loses hand-tuning | Several tools shape output for an agent's context budget in ways a REST client does not want. Those differences become declared projections or are given up, and some will be given up |
| The parity suite blocks merges | That is the point. A drifting pair stops a release until someone fixes it or removes the pair with a written reason. Teams who prefer the drift will feel this as friction, correctly |
| Dropping the lifecycle tools moves work to the plugin | Step handoffs and phases have 1-to-1 REST routes so core pays nothing — but the plugin must change its calls on its own clock, and nothing here can gate that half |
| The step-start bundle is four reads | An agent that called one tool now makes four REST reads; nothing marks the issue in-flight for it, so it moves the status itself |
