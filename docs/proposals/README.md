# Proposals

Planned features that are not yet implemented. When a proposal ships, its doc moves to
[../modules/](../modules/) (if a new feature) or gets absorbed into an existing module doc.

**Every row carries the date its status was last checked against the tree, and the check is
reading the file's body — not copying its `Status:` header.** Without that, a `Status` column is a
claim nobody re-reads: on 2026-08-25 this table said `rocketchat-bot` and
`chat-provider-standardization` were "not implemented" while both had shipped seven weeks earlier —
one of them in a commit naming that proposal's own issue. Four of the seven rows were wrong, and
three files in this directory were missing from the table entirely. A reader saw seven open items
where there were two.

The second half of that rule was added the same day and cost one more wrong row:
`release-gate-and-deploy.md` was written into this table as *"not implemented"* straight from its own
stale header, while all five of its waves were marked shipped 200 lines further down and every
anchor verified in the tree. **A proposal's header is the least-maintained line in it** — the body
carries the evidence.

## Current proposals

| Proposal | Status | Verified | Target |
|---|---|---|---|
| [agent-driven-pipeline.md](agent-driven-pipeline.md) | Phases 0–4 shipped; phase 5 instrumented and **awaiting evidence, not code** | 2026-08-25 | upgrade to an RFC once the mode switch + status vocabulary are agreed |
| [picker-selector-parity.md](picker-selector-parity.md) | Open residual — the dispatch picker and the runner selector filter on different clauses, so a job no runner can take reports `gateReason: null` | 2026-08-25 | mirror the pool predicate into `fresh_capable_runners` and assert the parity in a test |
| [browser-session-survival.md](browser-session-survival.md) | Open residual — a UI stage's browser crashes mid-session and the recovery is paid by hand, which is anhome's 3.38× clarify p95 | 2026-08-26 | answer whether a mid-session MCP death emits a `system`/`mcp_servers` event (the `got_init` line in `claude_code.rs`), then measure the crash rate by cause and choose between a session-surviving browser and a per-attempt isolated one |
| [release-permission-parity.md](release-permission-parity.md) | Open residual — the server requires `admin` to release, the three client surfaces require member / nothing / nothing, so a member is shown a button that always 403s | 2026-08-26 | one `useCanRelease` hook consumed by all three, disabled control stating its reason |
| [retry-context-continuity.md](retry-context-continuity.md) | Proposed, none of the four layers implemented — a retry starts its conversation from zero and abandons the failed attempt's uncommitted work, measured live on ISS-862 (645 messages lost, `session_context` NULL) | 2026-08-26 | L2 (retry prompt names the failed attempt) first; L1 (runner salvages WIP to the branch) needs a runner release |
| [issue-field-surface.md](issue-field-surface.md) | Proposed — five issue columns are written at create, read by no pipeline stage, and plumbed through 81 non-test source sites; `parent_issue_id` is 0/3442 fleet-wide yet has two live readers | 2026-08-27 | drop all six columns; the Onboarding C3 conflict was apparent only — ISS-454 shipped without ever building a consumer |

## Retired

Shipped or consumed proposals are **deleted** — git history is the design record, and
`git log --all --full-history -- docs/proposals/<name>.md` brings any of them back. Leaving one in
place costs more than it saves: it reads as open work.

The exception is a proposal **cited by path from source**: deleting it turns every one of those
comments into a dangling pointer, so it moves to `modules/` and the citations move with it. That is
the only reason `release-gate-and-deploy.md` still exists as a file.

| Retired | Why | Where it lives now |
|---|---|---|
| `release-gate-and-deploy.md` | All five waves shipped 2026-08-24; six modules in `core`/`contracts` name it as their design record, so it moved instead of being deleted | [../modules/issues-pipeline/release-gate.md](../modules/issues-pipeline/release-gate.md) |
| `mcp-principal-agency.md` | The decision it was blocked on was made 2026-08-25 (attribution follows the token's owner; the ISS-812 guard's scope is unchanged) and shipped in `aba0b10d` | `agency` on `McpPrincipal` + `principalActor()` in `mcp/tools/lib.ts` |
| `fan-out-scope.md` | The fix belongs to archmap, which is its own repo now — a Forge proposal describing another repo's work is filed in the wrong tracker | [SidCorp-co/archmap#1](https://github.com/SidCorp-co/archmap/issues/1) |
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

`<topic>.md` — short, kebab-case, topic-focused (e.g. `agent-driven-pipeline.md`). No `proposal-` prefix;
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
