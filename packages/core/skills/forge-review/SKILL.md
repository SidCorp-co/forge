---
name: forge-review
description: "Review code changes for Forge issues. Use this skill for independent code review with fresh context — checks diff against project conventions, finds bugs, security issues, and consistency problems. Triggers on: /forge-review, reviewing code, checking a diff, code review for an issue, reviewing PR changes. Used as a subagent by forge-code during the build+review step (before push), or standalone for manual review."
user_invocable: true
arguments: "[documentId]"
---

# Forge Review

Code review with fresh context. This skill is deliberately run without implementation context so it catches things the author missed due to familiarity bias.

Works in three modes:
- **Pipeline mode** — invoked with documentId, posts findings as issue comment, advances status
- **Subagent mode** — spawned by forge-code during Step 10, returns findings to caller
- **Standalone mode** — `/forge-review` with no args, reviews current branch diff

## Usage

```
/forge-review <documentId>    # pipeline — review + post comment + set status
/forge-review                  # standalone — review current branch diff
```

## Review Process

> **Pull-model note:** On large issues `forge_step_start` returns a lean manifest (`bodyTruncated:true`). Fetch `acceptanceCriteria`/`description` as needed via `forge_issues.get { documentId, fields: ['acceptanceCriteria'] }` rather than assuming full body is present.

### 1. Get the Diff

In pipeline mode, first make sure you're looking at the right code: `git fetch`, then check out the issue's ISS-* branch (from the check-in bundle / `sessionContext.branch`, else `git branch -r | grep ISS-XX`). Then diff the branch's **net change against the base branch** — robust no matter how many implementation/fix commits exist:

```bash
git fetch origin
BASE=$(git merge-base origin/<baseBranch> HEAD)
git diff "$BASE"..HEAD --stat
git diff "$BASE"..HEAD
git log --oneline "$BASE"..HEAD
```

`<baseBranch>` comes from `forge_config → get`. Avoid `HEAD~N` — counting implementation-vs-review/fix commits is error-prone and reviews the wrong slice.

**If there is no reviewable diff** — empty output, no ISS-* branch, or the branch isn't reachable (not pushed / `git fetch` brought nothing) — you **cannot review**. Do NOT report "clean" and do NOT advance status: this is an **ABSTAIN** (see Pipeline Exit). A false "approve" on an unreviewable change is exactly the failure this gate exists to prevent (the ISS-144/148 class).

### 1b. Load the contract (pipeline mode)

You have the issue in your check-in bundle (else `forge_issues → get`). Before reviewing, load the two things the verdict is measured against:
- **acceptanceCriteria** — axis 1 checks the diff against each line; an AC with no corresponding change is a finding.
- **plan** (the `plan` field / the `**Plan**` comment) — its **Affected Files** list is the scope contract. A file changed that the plan never mentions is **scope-creep** → at least a Minor finding (a Bug finding if it touches unrelated or risky surface); a planned file left untouched is also a finding.

### 2. Load Relevant Skills

Detect the stack from the changed files, then load only what applies:
- Load any matching `.claude/skills/*/SKILL.md` that exists for the detected stack — don't assume a framework.
- Also read `forge/.forge/lessons.md` if it exists — past gotchas to check against

### 3. Review along five axes

Review every diff against these five axes — they catch different failure classes, so don't collapse them into one "looks fine":

1. **Correctness** — wrong logic, null/undefined risks, race conditions, missing error handling, unhandled edge cases. Does it actually satisfy each `acceptanceCriteria` line?
2. **Readability & simplicity** — can a peer understand it without the author explaining? Clear names, no needless abstraction, no dead or commented-out code.
3. **Architecture** — follows project patterns, respects module boundaries, doesn't duplicate something that already exists, and is sized sensibly (a ~1000-line diff that should have been split is itself a finding). Watch web/backend parity when both are touched.
4. **Security** — injection, secrets in code, missing/wrong authorization, broken tenant/ownership scoping (resolve a resource's own owner and gate on that — never trust a caller-supplied scope id), unsanitized input, unsafe casts / `any` leaks that erase type guarantees.
5. **Performance** — N+1 queries, unbounded data or loops, missing pagination, memory leaks; for UI code: wrong effect deps, unmounted-component state updates, unstable list keys, unnecessary re-renders.

**UI behavior (when applicable)** — for any change touching `web`/`dev`/`app`/`widget` UI, if the calling agent has the Playwright MCP available (`mcp__playwright__browser_*` tools), navigate to the affected page on the running deploy and walk through each `acceptanceCriteria` line with `browser_navigate` + `browser_click` + `browser_evaluate` asserting expected post-state. Screenshot the final state for evidence. A static code review alone is insufficient for UI work — controlled-input bugs, focus order, scroll behavior, sticky headers, paging UI, and toast timing are routinely missed by diff inspection. If Playwright MCP isn't available in the host agent, note `e2e-not-verified` in the review summary so downstream verify steps can decide.

**UX completeness (if the project has a `ux-contract`)** — when the project has a `ux-contract` projectFact (a per-project UX standard, injected into your context) and the diff is user-facing, score the changed UI against its *Definition of UX-Done* in addition to the five axes. A missing applicable required-state / a11y / microcopy / responsive item on a **primary user surface** is a **Bug** finding — it gates the verdict (a functional-but-incomplete screen is NOT an approve). Projects without a `ux-contract` use the generic UI-behavior check above only.

**Docs-only diffs (no-code deliverables)** — when the diff touches **only `docs/**`** (no `packages/**`), e.g. a `docs/proposals/<topic>.md` decision/audit artifact, the document **is** the reviewable content. Review it for clarity, completeness, internal consistency, and correctness of the decision/recommendations — not for code defects. A present docs diff is never "nothing to review": approve a substantive doc; raise a Bug-severity finding (→ reopen) only when the artifact is empty, a stub, or incoherent. Skip build/type/test concerns — there is no code to compile.

### 3b. Adversarial doubt pass (non-trivial changes only)

For a change that introduces branching logic, crosses a module/service/tenant boundary, asserts a property you can't verify at a glance (idempotence, thread-safety, "this is scoped correctly", "this can never be null"), or carries irreversible blast radius (migration, public API, destructive data write), run one adversarial pass before writing the verdict:

1. Restate the **contract** the diff must satisfy in one line — from the acceptanceCriteria or the function's job. NOT how the author chose to solve it.
2. Re-read the diff trying to **disprove** it: *"Assume the author is overconfident. Where does this break — unstated assumptions, edge cases, hidden coupling, contract violations, failure modes?"*
3. Anchor every doubt to the **contract**, not to the author's reasoning. You're checking whether the code meets its obligation, not whether the approach sounds plausible — that's what stops a review from rubber-stamping.

Any disproof that survives a second read becomes a **Bug** finding. Skip this pass for trivial or localized diffs — it's for the changes where being wrong is expensive.

### 3c. Risk gate — multi-vote for high-risk diffs

Classify the diff before settling the verdict, using the changed-file list you already
computed (Step 1) + the issue `complexity`. The diff is **HIGH-RISK** if ANY holds:

- **schema / migration** — a changed path matches `**/schema*`, `**/migrations/**`, or `**/*.sql`.
- **auth / access-control / credentials** — a changed path matches `*auth*`, `*token*`, `*permission*`, or `*credential*`.
- **payment / billing** — a changed path matches `*payment*`, `*billing*`, `*checkout*`, or `*stripe*`.
- **blast radius** — changed-file count ≥ 10.
- **complexity** — `issue.complexity ∈ {l, xl}`.

Otherwise the diff is **ORDINARY**.

- **ORDINARY** → the single-pass review you just did (Steps 3–3b) stands. Continue to Step 4.
- **HIGH-RISK** → a lone reviewer is the rubber-stamp risk this gate removes. Run a
  **pass^k multi-vote**: 3 independent sub-reviewers across distinct lenses (correctness +
  security + an adaptive third), APPROVE only when **≥2/3 are clean**. Lens selection, the
  sub-reviewer prompt, the substantiation guard, aggregation/tally, out-voted-finding
  handling, and the Task-tool-absent fallback all live in
  [references/multi-vote.md](references/multi-vote.md). The multi-vote produces the SAME
  mechanical verdict (APPROVE / Bug-findings / ABSTAIN) — Step 5 is unchanged.

### 4. Output

```markdown
## Code Review — ISS-XX

Reviewed SHA: `<short-sha>`

| # | File | Line | Severity | Finding |
|---|------|------|----------|---------|
| 1 | path/to/file.ts | 42 | Bug | Description |
| 2 | path/to/file.ts | 88 | Minor | Description |

### Summary
- X bugs (must fix), Y minor (should fix), Z low (optional)
```

Severities: **Bug** (incorrect behavior), **Minor** (problematic pattern), **Low** (style/naming).

If clean: `No issues found. Implementation looks clean.`

Always include `Reviewed SHA: <short-sha>` in the comment body, even on a clean APPROVE. For full single-pass and multi-vote comment templates see [references/comment-format.md](references/comment-format.md).

**The review agent reports only — it does NOT fix code.**

### 5. Pipeline Exit (only when documentId provided)

Post findings as issue comment:
```
forge_comments → create → { data: { body: "<review output>", issue: "<documentId>", author: "Lapras" } }
```

- **No Bug findings (APPROVE)** → Check if the branch has been pushed: `git log origin/<branch> --oneline -1`. If pushed → `forge_issues → update → { data: { status: "testing" } }` — review exits **straight to `testing`** (the `developed → deploying → testing` hop was retired; `deploying` is no longer a valid status). If NOT pushed (subagent/standalone review before push) → do not change status, just post the review comment.
- **Has Bug findings** → `forge_issues → update → { data: { status: "reopen" } }`, comment serves as rejection. Forge-fix picks it up.
- **Could not review (ABSTAIN)** → no reviewable diff / branch unreachable (Step 1). Do **NOT** change status — leave it at `developed`; post a comment naming exactly what was missing (no ISS-* branch / empty diff / not pushed) so a human or a re-dispatch can resolve it. Never advance to `testing` on an unreviewable change, and don't send `reopen` either (forge-fix would have nothing to fix — an empty loop).

**Emit UX findings (pipeline mode only).** When the project has a `ux-contract` and the diff is user-facing, additionally record each UX gap you found (any severity) via `forge_ux_findings → write { stage: "review", kind: "missing-state"|"a11y"|"microcopy"|"responsive"|"design-system"|"other", detail, severity: "must"|"should" }`. This is a **non-blocking side-channel** separate from the comment + status transition (a failed emit never changes the verdict); issue/run are resolved server-side. Do this ONLY in **pipeline mode** (you have a documentId and are posting/advancing) — in subagent or standalone mode, return findings to the caller and write nothing.

## Review-specific output reminder

Findings go to `forge_comments.create`, NOT to chat. Don't print the review table twice. (See pipeline preamble for general output rules.)
