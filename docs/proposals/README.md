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
| [agent-driven-pipeline.md](agent-driven-pipeline.md) | Phases 0–4 shipped; the driver is `issue-flow` from the forge plugin. **The `staged` lane was deleted by ISS-897 (2026-09-03)** — `mode`, the eight `auto<Stage>` toggles, `sessionGroups` and `mergeStates` are out of the schema and off all 38 project rows, so this file's mode-switch runbook is removed and its staged-vs-autonomous comparison is a record of a decision, not a description of the tree. Phase 5's evidence never arrived; the sunset was decided on the observation that 0 projects had ever chosen `staged` | 2026-09-03 | nothing outstanding here — the residual (a `release` step for projects that DO have production) is ISS-897's own handover |
| [release-step-contract.md](release-step-contract.md) | Kernel side landed with ISS-897 (2026-09-03): the gate is project-derived, the release runner is mandatory, `RELEASE_RECORD_MISSING` guards the claim, and `readiness.ts` reports the gaps to settings. **No skill implements the protocol yet**, so a batch release dispatched today reaches a driver that does not know it. Two open questions named in the file: batch atomicity on a mid-batch failure, and whether the changelog gets one grouped entry or N lines | 2026-09-03 | a `release` skill in github.com/SidCorp-co/forge-plugin, after a human answers the two questions |
| [autonomous-session-pooling.md](autonomous-session-pooling.md) | Measured, awaiting a decision — the mechanism (`--input-format stream-json`) is real; pooling many issues into one session is refuted on four measurements (startup is 0.19% of a p50 drive job; the prompt cache is already warm across processes; `ZANZIBAR` crossed jobs in one session) | 2026-08-27 | one session per **issue** held across its park, not one per runner |
| [deploy-failure-retry.md](deploy-failure-retry.md) | Open decision, no code proposed — nothing retries a failed deploy today, and nothing chose that; raised by ISS-854, which removed the font-fetch cause but not the policy | 2026-08-26 | a human picks auto-retry vs keep-it-manual-and-fix-the-notice; the classification rule is the whole design if auto-retry wins |
| [picker-selector-parity.md](picker-selector-parity.md) | Open residual — the dispatch picker and the runner selector filter on different clauses, so a job no runner can take reports `gateReason: null` | 2026-08-25 | mirror the pool predicate into `fresh_capable_runners` and assert the parity in a test |
| [browser-session-survival.md](browser-session-survival.md) | Open residual — a UI stage's browser crashes mid-session and the recovery is paid by hand, which is anhome's 3.38× clarify p95 | 2026-08-26 | answer whether a mid-session MCP death emits a `system`/`mcp_servers` event (the `got_init` line in `claude_code.rs`), then measure the crash rate by cause and choose between a session-surviving browser and a per-attempt isolated one |
| [release-permission-parity.md](release-permission-parity.md) | Open residual — the server requires `admin` to release, the three client surfaces require member / nothing / nothing, so a member is shown a button that always 403s | 2026-08-26 | one `useCanRelease` hook consumed by all three, disabled control stating its reason |
| [release-note-seed-writeback.md](release-note-seed-writeback.md) | Open residual, out of this repo's reach — since ISS-880 an automated close is refused while `releaseNotes` is null, so a release step that derives a changelog line without persisting it back to the typed field is refused with a message that is false at that moment. The copies this tree owns already persist first; the offending one is a server-registered skill body | 2026-08-30 | persist the derived value before the close, in the same `forge_issues.update` call |
| [duplex-architecture.html](duplex-architecture.html) | Drawn architecture for RFC 0003 — components, lifecycle, queueing rule, the send/ack race, the question ledger, the journey. Figure 6 predates the second owner decision and says so inline | 2026-08-27 | redraw figure 6 without path C, then it tracks the RFC exactly |
| [cli-data-surface.html](cli-data-surface.html) | Steps 0 and 1 shipped (ISS-889): REST and MCP share one `createIssue` (`issues/create-service.ts`), one `setIssueDependency` (`issues/dependency-service.ts`) and one list envelope (`lib/pagination.ts`), and no tool under `mcp/tools/` holds a database handle — `no-transport-db.test.ts` keeps it that way. Step 1 landed as adapters over shared services, not over HTTP. The CLI itself is still undrawn work owned by no issue. Measured 2026-08-30: `mcp/tools/forge-issues.ts` (1,359 lines, reached drizzle directly) and `issues/routes.ts` (783) shared 4 modules and carried ~6 each the other lacked; **both** built their own `create` inline — `issues/creator.ts` is attribution, not a create path — and REST could already set a `blocks` edge via `issues/dependency-routes.ts`, but not atomically with the create | 2026-08-30 | MCP tools become thin adapters, then the CLI is a third caller of one surface — never a third implementation |
| [dropped-as-the-taught-discard.md](dropped-as-the-taught-discard.md) | Open residual — four agent-facing surfaces still teach `closed` + `unmark` for non-work instead of `dropped`, so the taught path is to stamp `merged_at` and then remember to unstamp it | 2026-08-27 | confirm `dropped` + edge expiry frees dependents identically, then change the prompt registry, its two parity tests, the affordances guide and `orientation.md` in ONE commit |
| [duplex-replaces-print.md](duplex-replaces-print.md) | Not started — the route for **ISS-873**, which is at `draft` behind two owner decisions (does chat move to duplex; is the session-scoped permit a hard prerequisite). Verified against the tree 2026-08-30: `sessionMode` is live in 4 files under `packages/*/src` and `'print'` in 3, so no phase has landed. Supersedes `duplex-architecture.html` wherever that drawing calls `sessionMode` the end state — here it is a migration device with a scheduled deletion | 2026-08-30 | the two owner decisions, then phase 1; `sessionMode` and `print` are both deleted by the last phase, not flagged off |
| [duplex-business-logic.html](duplex-business-logic.html) | Drawn — the business-logic delta between print and duplex, companion to `duplex-architecture.html`. Tracks the same undecided ISS-873 | 2026-08-30 | redraw whatever the two owner decisions move |
| [duplex-workflow-overview.html](duplex-workflow-overview.html) | Drawn — the end-to-end duplex workflow, companion to `duplex-architecture.html`. Tracks the same undecided ISS-873 | 2026-08-30 | redraw whatever the two owner decisions move |
| [runner-update-restart-deferral.md](runner-update-restart-deferral.md) | Open decision, no code proposed — a runner with `update.auto` stages the new binary and then never enters it: `drain_to_idle` is bounded at 30 min, and a `false` return falls through to the 6h tick with no pending-restart state, so the "next idle window" its own doc comment promises does not exist. Measured 2026-09-01 on `dev1 · CLI runner`: 25 hours and three cycles behind (0.9.2 running, 0.9.7 on disk, `/proc/<pid>/exe` marked `(deleted)`), while the box reached idle eight times outside the window | 2026-09-01 | a human picks keep-the-bound vs hold the restart intent until in-flight hits zero; whether a staged-but-not-entered update gets its own signal is the same decision |
| [changelog-omission-is-unguarded.md](changelog-omission-is-unguarded.md) | Open decision, no code proposed — the close refusal guards a null `releaseNotes` on an *automated* close and `no-silent-loss` guards an entry that *disappears*; nothing guards an entry that is never written, and core never reads `CHANGELOG.md` while CI never reads the issue table. Measured 2026-09-02 over the 19 issues closed 2026-08-29..31: two shipped with no line — one of them with `releaseNotes` populated, so the refusal was satisfied and the reader still got nothing | 2026-09-02 | a human picks whether a manual close prompts for its release note, and whether that prompt writes the file or only the field |
| [body-templates.md](body-templates.md) | **P1 shipped by ISS-898 (2026-09-03)** — the registry (`packages/core/src/body/`), the kernel validate/normalize gate at all seven caller-supplied write doors, `format`/`template` columns with CHECK constraints on `comments` and `issues`, `forge_comments.update`, `slots`/`text` on the MCP read surface, and the `toText()` projection at four read paths. Body verified against the tree: `body/doors.test.ts` asserts each door and each read path, and 7 real-Postgres cases cover the columns. P2 (web renderer + composer), P3 (the six string-prefix readers, in a mandatory order) and P4 (`bodyPolicy`, adoption metrics) are unstarted and unfiled. Records three places the original proposal was wrong about this tree, so P2-P4 do not repeat them | 2026-09-03 | P2's web renderer, which needs its own component map because the registry is core-internal |
| [ux-contract-direction.md](ux-contract-direction.md) | Two of three moves done. Contracts written and injected for all **10** frontend repos that lacked one (13 projects now carry one); ISS-576 + ISS-864..867 **dropped 2026-08-30** and the dead Re-scan control removed. Found and fixed on the way: `recompileAndPersistUxContract` never SET `alwaysInject`, so a contract created by the apply-preset button reached no agent — `qa-project` had 22 rules compiled and dark since 2026-08-11. The improver is the one open half: it forms one cluster per finding (26→26, 42→42) and its similarity classes are **not separable at any threshold** on real data, so it is a design decision, not a tuning fix | 2026-08-31 | choose between agent-side clustering, embeddings, or dropping the learning loop — and replace the `ux-improver-detect` fixtures, which cannot fail |
| [retrieval-v3-rerank-chunks.md](retrieval-v3-rerank-chunks.md) | Phases 0, 1 and 3 shipped (ISS-904, ISS-905): hybrid search records what each list gave, an admin breakdown reads it, four `app_config` flags exist, and with them on an agent's hybrid search is reranked by the fast model (one-in-five holdout as control) and issue hits pull in their one-hop `blocks`/`relates` neighbours. Still proposed: phase 2, a chunked memory model as a sibling `memory_chunks` table with a resumable reindex on the flip and a UNION read that is correct mid-migration (ISS-906); phase 4, an identifier-aware tsvector gated on measured keyword contribution (ISS-907, opened only on phase-0 evidence) | 2026-09-04 | open ISS-906; ISS-907 once a week of forge-dev breakdown rows exists |

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
