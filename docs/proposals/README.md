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
| [autonomous-session-pooling.md](autonomous-session-pooling.md) | Measured, awaiting a decision — the mechanism (`--input-format stream-json`) is real; pooling many issues into one session is refuted on four measurements (startup is 0.19% of a p50 drive job; the prompt cache is already warm across processes; `ZANZIBAR` crossed jobs in one session) | 2026-08-27 | one session per **issue** held across its park, not one per runner |
| [picker-selector-parity.md](picker-selector-parity.md) | Open residual — the dispatch picker and the runner selector filter on different clauses, so a job no runner can take reports `gateReason: null` | 2026-08-25 | mirror the pool predicate into `fresh_capable_runners` and assert the parity in a test |
| [browser-session-survival.md](browser-session-survival.md) | Open residual — a UI stage's browser crashes mid-session and the recovery is paid by hand, which is anhome's 3.38× clarify p95 | 2026-08-26 | answer whether a mid-session MCP death emits a `system`/`mcp_servers` event (the `got_init` line in `claude_code.rs`), then measure the crash rate by cause and choose between a session-surviving browser and a per-attempt isolated one |
| [release-permission-parity.md](release-permission-parity.md) | Open residual — the server requires `admin` to release, the three client surfaces require member / nothing / nothing, so a member is shown a button that always 403s | 2026-08-26 | one `useCanRelease` hook consumed by all three, disabled control stating its reason |
| [duplex-architecture.html](duplex-architecture.html) | Drawn architecture for RFC 0003 — components, lifecycle, queueing rule, the send/ack race, the question ledger, the journey. Figure 6 predates the second owner decision and says so inline | 2026-08-27 | redraw figure 6 without path C, then it tracks the RFC exactly |
| [cli-data-surface.html](cli-data-surface.html) | Step 0 shipped (ISS-889): REST and MCP now share one `createIssue` (`issues/create-service.ts`) and one `setIssueDependency` (`issues/dependency-service.ts`). The CLI itself is still undrawn work. Measured 2026-08-30: `mcp/tools/forge-issues.ts` (1,359 lines, reached drizzle directly) and `issues/routes.ts` (783) shared 4 modules and carried ~6 each the other lacked; **both** built their own `create` inline — `issues/creator.ts` is attribution, not a create path — and REST could already set a `blocks` edge via `issues/dependency-routes.ts`, but not atomically with the create | 2026-08-30 | MCP tools become thin adapters, then the CLI is a third caller of one surface — never a third implementation |
| [dropped-as-the-taught-discard.md](dropped-as-the-taught-discard.md) | Open residual — four agent-facing surfaces still teach `closed` + `unmark` for non-work instead of `dropped`, so the taught path is to stamp `merged_at` and then remember to unstamp it | 2026-08-27 | confirm `dropped` + edge expiry frees dependents identically, then change the prompt registry, its two parity tests, the affordances guide and `orientation.md` in ONE commit |

## Retired

Shipped or consumed proposals are **deleted** — git history is the design record, and
`git log --all --full-history -- docs/proposals/<name>.md` brings any of them back. Leaving one in
place costs more than it saves: it reads as open work.

A proposal **cited by path from source** cannot simply be deleted — that turns every one of those
comments into a dangling pointer. Either it moves to `modules/` and the citations move with it, or
the citations go in the same commit.

| Retired | Why | Where it lives now |
|---|---|---|
| `release-gate-and-deploy.md` | All five waves shipped 2026-08-24; moved to `modules/`, then deleted with the rest of the module tree in the 2026-08-28 docs cleanup — the seven `core`/`contracts` pointers to it were removed in the same pass | git history · `release-batch/`, `issues/release-gate-hold.ts` |
| `issue-field-surface.md` | All three steps shipped in `5d69e35f` 2026-08-27: five write-only columns plus `parent_issue_id` dropped by migration `0188`, 81 plumbing sites removed, and the two dead readers of `parent_issue_id` deleted. No source cites it by path, so the retire rule applies | git history |
| `retry-context-continuity.md` | L1–L3 shipped 2026-08-26 (`da2a2189` core, `948d50f6`+`c1080aa9` runner). L4 (hold instead of rotating into exhausted accounts) is the only residual, and its own body says it belongs to ISS-862's scope rather than to a separate proposal | git history · L4 → ISS-862 |
| `mcp-principal-agency.md` | The decision it was blocked on was made 2026-08-25 (attribution follows the token's owner; the ISS-812 guard's scope is unchanged) and shipped in `aba0b10d` | `agency` on `McpPrincipal` + `principalActor()` in `mcp/tools/lib.ts` |
| `fan-out-scope.md` | The fix belongs to archmap, which is its own repo now — a Forge proposal describing another repo's work is filed in the wrong tracker | [SidCorp-co/archmap#1](https://github.com/SidCorp-co/archmap/issues/1) |
| `rocketchat-bot.md` | Lane A shipped + live; its own body carried three SHIPPED markers (ISS-609, ISS-671/672/674/675/687/727) while this table said otherwise | `packages/core/src/chat/providers/` |
| `chat-provider-standardization.md` | P1 shipped 2026-07-02 in `934dab4a`, the commit naming its own ISS-604; P2 2026-07-03 (ISS-609); P3 write tools live in `chat/tools/` | `packages/core/src/chat/providers/` |
| `pm-lane-audit.md` | An audit whose decision was consumed — ISS-795 and its step 5 (ISS-801) both closed and merged 2026-08-08/09 | git history |
| `cost-aware-model-routing.md` | Schema + cost rollup shipped; routing never written in the four months after 2026-04-20 | rollup: `pipeline_run_step_durations` (root `CLAUDE.md`) |
| `mcp-project-scoped-tokens.md` | Design capture 2026-06-16 (ISS-496); no trace in the tree since | git history |
| `memory-rag-retrieval-quality.md` | Research deliverable 2026-06-16; no trace in the tree, and never listed in this table at all | git history |

Earlier retirements, and where they live now: memory v2 →
`packages/core/src/memory/` · web-v2 redesign/parity (ISS-397)
→ web-v2 is simply the canonical UI · step-handoff →
`packages/core/src/memory/step-handoff-schema.ts` ·
runner daemon → `packages/runner/README.md` · integration
framework → [../integrations/README.md](../integrations/README.md) · prompt config →
`packages/core/src/prompt/state-prompts/` · skill facts →
`packages/core/src/prompt/facts/registry.ts`.

## Every proposal prices itself

**Required section, gated:** every `.md` here, subdirectories included, carries a `## Honest costs` heading saying what
adopting the proposal takes away from whoever adopts it — for an open residual, the cost of the
proposed fix, not of the bug it fixes. Boundaries and non-goals are a different question and do not
satisfy it.

| | |
|---|---|
| Shape | a table or a list, one cost per row — not a paragraph |
| Refused | an absent section · a section that prices nothing · `TBD` / `N/A` where the price goes |
| Gate | `node scripts/check-honest-costs.mjs`, run by `pnpm verify` and by CI's `lang-check` job |
| Not gated | whether the stated price is honest — that is review's, and the author's |

`docs/VISION.md` is held to the same rule. A `README.md` at any depth is an index rather than a
proposal, and the `.html` files are drawn figures with no markdown heading tree, so neither is in scope.

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
| Lifespan | Short — deleted on ship; moves to modules/ only if source cites it | Permanent historical record |

Use `proposals/` for "I'm thinking about this, not sure yet." Upgrade to an `rfcs/` RFC when the
proposal affects API, architecture, or cross-team surfaces.
