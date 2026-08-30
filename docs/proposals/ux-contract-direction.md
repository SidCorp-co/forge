# UX Contract — the value is in the prose, not in the table

**Open decision.** Nothing here is code. It asks where the remaining UX Contract investment goes,
and proposes retiring the branch that has cost the most and returned the least.

Measured 2026-08-30 against the live forge-beta database (`ux_contract_rules`, `ux_findings`,
`projects.agent_config`, `skills`).

## What the feature is for

An agent writing UI ships the happy path. The defect class is **absence** — no loading, no
error+retry, no filtered-empty distinct from first-run empty, breakage at 375px, focus not
restored, enum codes leaked to the user. Nothing in a diff shows what is not there. A human
reviewer catches it from a checklist held in their head; an agent has no such head.

The contract is that checklist, project-specific, injected into the preamble, so review can say
`REQUEST CHANGES: §2 missing empty-search` instead of `looks good`.

It works. Real defects it caught, from the 68 recorded findings:

| Finding | Class |
|---|---|
| `w-[--radix-popover-trigger-width]` compiles to `width:--radix-popover-trigger-width` under Tailwind v4 — the declaration is dropped, so a 601px dropdown renders in a 375px viewport with options off-screen. Every `modal` picker call site. | real bug, measured live |
| A search debounce is not cleared on route unmount, so the queued setter fires against the **destination** route — a hidden filter with no visible cause. Three hooks share the idiom. | real bug, reproduced live |
| A month-calendar zero-rows branch renders `EmptyState` *instead of* the grid, removing the ‹ › month navigation. An empty state that swallows its own surface's navigation is a dead end. | real dead end |
| A prefilled participant field materialises a person as having accepted a role they never acted on, when an adjacent field is edited. | data integrity |
| `whoami` error leaves `data` undefined, so NavRail and ScreenTabs render nothing and all six `/admin` sections become unreachable — no ErrorState, no retry. | real bug |

## Where the value actually comes from

There is a natural experiment already in the data.

| Project | Contract lives in | Rows in `ux_contract_rules` | Findings |
|---|---|---|---|
| anhome | hand-written prose, 4,060 chars, `agent_config.projectFacts['ux-contract']` | **0** | **42** |
| forge-dev | prose compiled from 22 preset rules | 22 | 26 |
| qa-project | prose compiled from 22 preset rules, generic | 22 | 0 |

The project with **zero rows in the structured table** produces the most findings and the sharpest
ones. Its contract knows that numbers use `NumberInput` and never `<input type=number>`, that the
copy is Vietnamese so correct Vietnamese must **not** be flagged as an i18n violation, and that one
route group is frozen while another is the focus area. A preset cannot generate any of those
sentences.

What the structured layer has returned, in 19 days:

| Signal | Value |
|---|---|
| rules | 44, across 2 projects, **100% `source='preset'`, 100% `status='active'`** |
| `manual` / `detected` / `learned` / `proposed` / `retired` rules | 0 / 0 / 0 / 0 / 0 |
| last rule mutation of any kind | 2026-08-11 — none since |
| findings citing the rule they violate, on the only project where citation was possible | 0 / 26 |
| schedules of template `ux-contract-improve` | 0, out of 13 schedules total |

The propose/approve inbox has never been used. The standing improver — `ux-improver-detect.ts`
(14KB with tests), `ux-improver.ts`, `ux-improver-prompt.ts`, its registry entry and its dispatch
wiring — has never been instantiated on any project.

## The gap that was actually costing something — now closed

`forge-code` and `forge-clarify` carry the instruction to read `projectFacts['ux-contract']`;
`forge-review` and `forge-test` carry `forge_ux_findings`. That wiring reaches 45 registered skill
bodies across 24 projects. Only 3 projects had a contract for it to read.

The honest denominator is not 24: a `forge-review` body is the fleet-wide one, so a backend-only
repo counts as "wired" while owing nothing. Measured against repos that actually hold a frontend,
**10 lacked a contract**. All 10 were written on 2026-08-31 and flagged `alwaysInject`:
`getcontent`, `sidpeak`, `sid-desk`, `epodsystem-core`, `finance-automation`, `sidboss`,
`brand-gateway`, `ceo-dashboard`, `sidcorp-mail`, `kinetrak`. Each is repo-specific in the way
anhome's is — it names that codebase's own primitives, its own traps, and the surfaces it must not
bind to.

### A delivery defect found while writing them

`recompileAndPersistUxContract` **read** `projectFactsConfig['ux-contract'].alwaysInject` and never
**set** it. An absent key means fetch-on-demand, while `forge-code` and `forge-clarify` both tell the
agent the contract arrives "injected in your preamble" — so a contract created by the Settings
apply-preset button reached no agent at all unless somebody separately knew to flip that flag.

`qa-project-available-for-testing` is the proof: 22 active rules, compiled to 2,925 characters on
2026-08-11, `alwaysInject` never set, zero findings since. The two projects where the loop worked had
the flag set by hand.

Fixed in this change: recompile now defaults the flag ON when the key is **absent**, and leaves an
explicit `false` alone because that is a human's decision. Three tests cover it, and all three go red
against the old code.

## Proposal

**1. Write contracts for the frontend projects that lack one. — DONE 2026-08-31.** All 10 written and
injected; the delivery defect above was found and fixed on the way. Follow the same shape for the
next repo: hand-written, repo-specific, naming the actual components and the actual traps — not the
generic preset, which is what the two low-yield projects have. What made each one specific, and what
the next author should look for: which directory is live versus abandoned (sid-hrm's `frontend/` has
335 commits in 60 days against `frontend-v2/`'s 4 — the name lies), which primitives already exist
and go unused (`Skeleton` is imported 0 times in getcontent's features), whether the UI is
Vietnamese, English or lint-enforced bilingual, and the one domain rule that outranks the rest
(untrusted mail HTML, a reconciliation delta, a key shown once, a stale BI figure).

**2. Retire ISS-576 and its four children (ISS-864, ISS-865, ISS-866, ISS-867). — DONE 2026-08-30.**
Auto-detect exists to populate `source='detected'`, a path that has never held a row, in a table the
highest-yield project does not use at all. It cost 11 sessions and six review rejections to automate
typing eight fields once per project.

All five went to **`dropped`**, not `closed` + `unmark`. `apply-transition.ts` routes `closed`
through `markMergedOnClose` and `dropped` past it, so `dropped` never stamps `merged_at` in the
first place — there is nothing to unmark, and `drop-cascade.ts` expires the edges so dependents
are freed anyway. Verified after the fact: `mergedAt: null` on all five. This is the verb
[dropped-as-the-taught-discard.md](dropped-as-the-taught-discard.md) argues four agent-facing
surfaces should be teaching.

The dead Re-scan control in the Settings tab went with them, since the issue its tooltip named no
longer exists.

**3. The improver is blocked on a design error, not on a missing run — measured, not predicted.**

The two-week trial this section used to propose is unnecessary: `forge_ux_improver action=candidates`
is deterministic and answers immediately. Run 2026-08-30 on both projects that have findings:

| Project | Findings considered | Clusters formed | Candidates |
|---|---|---|---|
| forge-dev | 26 | **26** | 0 |
| anhome | 42 | **42** | 0 |

Every finding forms its own cluster of one, so nothing ever reaches the ≥3-distinct-issues bar.

That is not because the findings lack recurrence. anhome's set contains four findings, on **four
distinct issues**, all reporting the same defect: shadcn's English `sr-only` "Close" label in a
Vietnamese-only UI, fixed in `components/ui/dialog.tsx` and `sheet.tsx`. It qualifies on every
stated criterion and the detector splits it four ways.

Two causes, both measured with the production functions in `ux-improver-detect.ts`:

- **The similarity classes are not separable at any threshold.** Across anhome's real findings, the
  four same-defect pairs score Jaccard **0.193–0.487** while unrelated pairs reach **0.424**. The
  ranges overlap. Lowering `SIMILARITY_THRESHOLD` to catch the true cluster admits a large share of
  the false ones; `overlap` and `dice` coefficients were measured on the same data and overlap the
  same way. Bag-of-words similarity over full finding prose cannot separate these two classes.
- **`normalizeTokens` erases Vietnamese.** `[^a-z0-9]+` strips every diacritic and the surviving
  fragments fall under the 3-character floor: `Đóng` → `[]`, `Bộ lọc đã lưu` → `[]`,
  `Khách cọc giữ chỗ` → `[]`, `Thoát mà không lưu` → `["tho"]`. The project with the richest
  findings and a Vietnamese-only UI contributes almost no signal.

The unit tests pass because their fixtures are three short, near-duplicate English sentences of
~12 tokens. Real findings average 45. **The test runtime cannot represent the failure**, so its
green says nothing about the case that matters.

The deeper error is the split itself. `registry.ts` states it as *"counting recurrence is
deterministic and lives in core; judging whether a recurring gap deserves a permanent rule is what
this agent adds."* But deciding whether two findings describe the same gap **is** the judgement, and
deciding whether a recurring gap deserves a rule is the easy half. The architecture gave the hard
half to a word counter.

So: neither keep-as-is nor delete. The options worth pricing are (a) let the agent cluster — hand it
the findings, not a pre-clustered aggregation, and keep the deterministic part for counting once the
agent has grouped; (b) cluster on embeddings, which `knowledge_entries` already demonstrates in this
schema, at the cost of an `embedding` column and a backfill on `ux_findings`; (c) drop the learning
loop and keep the contract hand-written, which is what the highest-yield project already does.

Whichever wins, the fixtures must be replaced with real finding text first — the current ones cannot
fail.

Only if (c) wins does the follow-on question become worth asking: whether 44 preset rows justify
`ux_contract_rules`, the compiler and the settings tab at all, when one `alwaysInject` knowledge
entry already delivers the whole measured benefit.

## What this does not propose

Removing the contract, the injection, or `forge_ux_findings`. Those are the parts that work, and
they are `kernel-hard-policy-soft` done correctly: the policy is prose the team writes, the kernel
only delivers it.

## Honest costs

| The move | What it costs |
|---|---|
| Hand-written contracts per project | someone with judgment about that codebase writes 4,000 characters per repo, and rewrites them when the stack moves. There is no preset that produces anhome's yield, so this cost cannot be automated away — that is the finding, not an implementation gap |
| Retiring ISS-576 | eleven sessions of work is discarded, including a branch that resolved four rounds of review blockers. If a project later wants detection, it starts from the evidence branch rather than from a merge |
| Retiring ISS-576 | the Settings tab loses its Re-scan button outright, so the stack profile is read-only and a project that later wants detection has no in-product entry point — someone must re-add the control along with whatever revives it |
| Agent-side clustering (3a) | every improver run pays tokens over the whole finding set instead of a cheap deterministic pass, and clustering stops being reproducible — two runs on identical data may group differently, so a proposal's evidence list is no longer a stable identity |
| Embedding-based clustering (3b) | a migration, an `embedding` column on `ux_findings`, a backfill, and an embedding call on every finding write. It also buys a second answer that cannot be read: nobody can tell from a row why two findings were judged the same |
| Dropping the learning loop (3c) | drift detection and rule learning leave the roadmap. A contract then strengthens only when a human edits it — the same hand that must write it in the first place, so the cost lands on exactly the person move 1 already taxes |
| Replacing the test fixtures before any of the three | the existing `ux-improver-detect` tests go red, because they were green against 12-token synthetic sentences. Fixing them means accepting that the suite protected nothing here, and re-deriving what the thresholds should be from data rather than from the fixtures that were built to satisfy them |
| Doing none of this | the 10 frontend repos measured without a contract keep running a review instruction against an empty fact, and the structured layer keeps reading as an unfinished feature rather than an unused one |
