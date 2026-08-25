# Proposals

Planned features that are not yet implemented. When a proposal ships, its doc moves to
[../modules/](../modules/) (if a new feature) or gets absorbed into an existing module doc.

**Every row carries the date its status was last checked against the tree.** Without that, a
`Status` column is a claim nobody re-reads: on 2026-08-25 this table said `rocketchat-bot` and
`chat-provider-standardization` were "not implemented" while both had shipped seven weeks earlier —
one of them in a commit naming that proposal's own issue. Four of the seven rows were wrong, and
three files in this directory were missing from the table entirely. A reader saw seven open items
where there were two.

## Current proposals

| Proposal | Status | Verified | Target |
|---|---|---|---|
| [release-gate-and-deploy.md](release-gate-and-deploy.md) | Draft — design agreed in an owner session, not implemented | 2026-08-25 | 5 waves, gated per project: kernel truths → the gate → release path → deploy+proof → schedule+UI |
| [agent-driven-pipeline.md](agent-driven-pipeline.md) | Phases 0–4 shipped; phase 5 instrumented and **awaiting evidence, not code** | 2026-08-25 | upgrade to an RFC once the mode switch + status vocabulary are agreed |
| [fan-out-scope.md](fan-out-scope.md) | Draft — needs `scope: "module"` in archmap; unblocked once that ships | 2026-08-25 | one archmap change, then the `index.ts` split it currently forbids |
| [mcp-principal-agency.md](mcp-principal-agency.md) | Blocked on a **decision**, not on code — it changes who the ISS-812 fabrication guard applies to | 2026-08-25 | an `agency: 'human' \| 'agent'` field on `McpPrincipal` |

## Retired

Shipped or consumed proposals are **deleted** — git history is the design record, and
`git log --all --full-history -- docs/proposals/<name>.md` brings any of them back. Leaving one in
place costs more than it saves: it reads as open work.

| Retired | Why | Where it lives now |
|---|---|---|
| `rocketchat-bot.md` | Lane A shipped + live; its own body carried three SHIPPED markers (ISS-609, ISS-671/672/674/675/687/727) while this table said otherwise | [../modules/chat/README.md](../modules/chat/README.md) § RocketChat inbound flow |
| `chat-provider-standardization.md` | P1 shipped 2026-07-02 in `934dab4a`, the commit naming its own ISS-604; P2 2026-07-03 (ISS-609); P3 write tools live in `chat/tools/` | [../modules/chat/README.md](../modules/chat/README.md) |
| `pm-lane-audit.md` | An audit whose decision was consumed — ISS-795 and its step 5 (ISS-801) both closed and merged 2026-08-08/09 | git history |
| `cost-aware-model-routing.md` | Schema + cost rollup shipped; routing never written in the four months after 2026-04-20 | rollup: `pipeline_run_step_durations` (root `CLAUDE.md`) |
| `mcp-project-scoped-tokens.md` | Design capture 2026-06-16 (ISS-496); no trace in the tree since | git history |
| `memory-rag-retrieval-quality.md` | Research deliverable 2026-06-16; no trace in the tree, and never listed in this table at all | git history |

Earlier retirements, with their live docs: memory v2 →
[modules/memory-knowledge](../modules/memory-knowledge/README.md) · web-v2 redesign/parity (ISS-397)
→ web-v2 is simply the canonical UI · step-handoff →
[../modules/memory-knowledge/step-handoffs.md](../modules/memory-knowledge/step-handoffs.md) ·
runner daemon → [../architecture/runner-daemon.md](../architecture/runner-daemon.md) · integration
framework → [../integrations/framework.md](../integrations/framework.md) · prompt config →
[../modules/agents-jobs/prompt-config.md](../modules/agents-jobs/prompt-config.md) · skill facts →
[../modules/agents-jobs/skill-facts.md](../modules/agents-jobs/skill-facts.md).

## Naming convention

`<topic>.md` — short, kebab-case, topic-focused (e.g. `fan-out-scope.md`). No `proposal-` prefix;
the directory already says "proposal."

This is also the home for **no-code pipeline deliverables**: when an issue's only output is a
decision, audit or spike, the pipeline materializes it here as `docs/proposals/<topic>.md` so it
becomes a mergeable, reviewable artifact (see the forge-plan / forge-code skills). Those are
**consumed** rather than shipped — retire one when the decision it carries has been acted on, the
way `pm-lane-audit.md` was.

## How this differs from `rfcs/`

| | `proposals/` | `rfcs/` |
|---|-------------|---------|
| Formality | Sketch, one-page | Full template, FCP |
| Status | Might not ever ship | Decided (accept/postpone/reject) |
| Audience | Maintainer + early contributors | Full community |
| Lifespan | Short — moves to modules/ on ship | Permanent historical record |

Use `proposals/` for "I'm thinking about this, not sure yet." Upgrade to an `rfcs/` RFC when the
proposal affects API, architecture, or cross-team surfaces.
