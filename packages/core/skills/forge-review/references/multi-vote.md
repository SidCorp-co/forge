# Multi-vote / pass^k review gate (HIGH-RISK diffs only)

The single-pass review is one reviewer's opinion — fine for ordinary diffs, but on a
high-risk diff (schema/migration/auth/payment, ≥10 files, or complexity `l`/`xl` — see the
`### 3c. Risk gate` predicate in [`../SKILL.md`](../SKILL.md)) a lone reviewer is the
rubber-stamp risk this gate exists to remove. For those diffs, run **three independent
reviewers across distinct lenses and APPROVE only when ≥2/3 are clean** (pass^k: a majority
must independently agree the change is safe, not just one pass@1 reviewer).

## Lenses (3 reviewers)

Two are fixed, the third adapts to what the diff touches:

| # | Lens | Always? | Focus |
|---|------|---------|-------|
| 1 | **Correctness** | yes | Bugs/logic, null/undefined, races, error handling, AC satisfied. |
| 2 | **Security** | yes | Injection, broken access control, missing auth/tenant scope, secrets, unsanitized input. |
| 3 | **Adaptive third** | yes | Pick by diff surface (below). |

Third-lens selection:
- Diff touches a **user-facing surface** (any web/app/widget frontend — UI components/JSX) →
  **UI-&-flow parity** (visual integrity, loading/empty/error states, flow dead-ends).
- Otherwise (pure backend/infra/migration diff) → **data-integrity / migration-safety /
  API-contract** (UI-parity is meaningless there).

All three apply the five axes in [../SKILL.md](../SKILL.md) §3 (Correctness, Readability,
Architecture, Security, Performance), each weighted to its lens.

## How to spawn the reviewers

**Preferred — parallel sub-agents (Task/Agent tool).** Spawn the 3 reviewers in one batch so
they run concurrently and independently. Each gets a fresh context (no implementation bias,
no awareness of the other voters). The sub-reviewer prompt template:

> You are ONE independent code reviewer, vote #N of 3, reviewing through the **\<lens\>** lens.
> Here is the diff range to review: `<MERGE_BASE>..<REMOTE>/ISS-XX-short-title` (run the same
> `git diff` the skill uses). Apply the five review axes in `../SKILL.md` §3, weighted to your
> lens. Issue acceptance criteria: \<paste\>. Return ONLY substantiated `Bug` findings — each
> must cite `file:line` + the concrete mechanism by which it breaks. A vague "this feels risky"
> with no file:line is NOT a Bug and must be omitted. End with a one-line verdict: `CLEAN` (zero
> substantiated Bug findings) or `NOT-CLEAN` (≥1), plus your full findings list (any severity)
> for the aggregator.

**Fallback — Task tool unavailable.** Do NOT fail the job. Run the 3 reviewers as **sequential
fresh-context reasoning passes** in this same session, each adopting one lens in turn, then
aggregate identically. A degraded sequential run is NOT an ABSTAIN — the review must never
ABSTAIN merely because parallel spawn was unavailable.

> ⚠️ Sub-agents do NOT inherit the Forge pipeline preamble or MCP context. They REVIEW and
> RETURN findings only. ALL MCP writes — the review comment, `createTask`, the status
> transition — happen in the **main loop** (this session), never inside a sub-reviewer.

## Substantiation guard (anti-false-positive)

A `Bug` counts toward a reviewer's **NOT-CLEAN** vote only if it is **substantiated**:
`file:line` + a concrete mechanism by which it breaks. This is the only filter — there is no
separate adversarial-refute pass (three diverse lenses already give the independence pass^k
needs; a refute layer would double an already-3× cost for marginal gain). An unsubstantiated
"feels risky" never flips a vote.

## Aggregation (mechanical, auditable)

1. Collect each reviewer's verdict (`CLEAN` = zero substantiated Bug findings) + its findings.
2. **APPROVE iff ≥2 of 3 reviewers are CLEAN.** Otherwise **Bug-findings verdict**.
   - A Bug corroborated by ≥2 reviewers automatically fails the ≥2/3-clean test →
     Bug-findings verdict (no special case needed).
3. Record the **union of all Bug findings** across the 3 reviewers in the comment,
   regardless of the vote, so nothing a single reviewer caught is hidden.
4. **Out-voted Bug on an APPROVE** (a Bug flagged by only 1 reviewer while ≥2 were clean →
   still APPROVE): the finding is NOT lost — file it via `forge_issues.createTask`
   (`data.issueId` = this issue) before transitioning, exactly like a `Minor`/`Low` finding
   on a single-pass APPROVE (the existing rubber-stamp safety net).
5. **ABSTAIN** only if the review harness itself cannot run (diff inscrutable, branch missing,
   file-read failures) — unchanged from single-pass. A degraded sequential run is NOT an
   ABSTAIN.

Verdict → transition is unchanged: APPROVE → `testing`, Bug-findings → `reopen`,
ABSTAIN → halt at `developed`. Record the per-reviewer table + aggregate tally per the
multi-vote block in [comment-format.md](comment-format.md) so the ≥2/3 decision is
reconstructable from the comment alone.

## Model routing (soft note — ISS-535)

Ship multi-vote on the default model now. When per-stage / per-call model routing lands,
route the sub-reviewers to the deep tier for sharper judgement. This is a follow-up
optimization, NOT a blocker for the multi-vote path.
