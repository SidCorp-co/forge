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

### 1. Get the Diff

```bash
git diff HEAD~N --stat
git diff HEAD~N
git log --oneline HEAD~N..HEAD
```

N = number of implementation commits (exclude previous review/fix commits).

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

**Docs-only diffs (no-code deliverables)** — when the diff touches **only `docs/**`** (no `packages/**`), e.g. a `docs/proposals/<topic>.md` decision/audit artifact, the document **is** the reviewable content. Review it for clarity, completeness, internal consistency, and correctness of the decision/recommendations — not for code defects. A present docs diff is never "nothing to review": approve a substantive doc; raise a Bug-severity finding (→ reopen) only when the artifact is empty, a stub, or incoherent. Skip build/type/test concerns — there is no code to compile.

### 3b. Adversarial doubt pass (non-trivial changes only)

For a change that introduces branching logic, crosses a module/service/tenant boundary, asserts a property you can't verify at a glance (idempotence, thread-safety, "this is scoped correctly", "this can never be null"), or carries irreversible blast radius (migration, public API, destructive data write), run one adversarial pass before writing the verdict:

1. Restate the **contract** the diff must satisfy in one line — from the acceptanceCriteria or the function's job. NOT how the author chose to solve it.
2. Re-read the diff trying to **disprove** it: *"Assume the author is overconfident. Where does this break — unstated assumptions, edge cases, hidden coupling, contract violations, failure modes?"*
3. Anchor every doubt to the **contract**, not to the author's reasoning. You're checking whether the code meets its obligation, not whether the approach sounds plausible — that's what stops a review from rubber-stamping.

Any disproof that survives a second read becomes a **Bug** finding. Skip this pass for trivial or localized diffs — it's for the changes where being wrong is expensive.

### 4. Output

```markdown
## Code Review — ISS-XX

| # | File | Line | Severity | Finding |
|---|------|------|----------|---------|
| 1 | path/to/file.ts | 42 | Bug | Description |
| 2 | path/to/file.ts | 88 | Minor | Description |

### Summary
- X bugs (must fix), Y minor (should fix), Z low (optional)
```

Severities: **Bug** (incorrect behavior), **Minor** (problematic pattern), **Low** (style/naming).

If clean: `No issues found. Implementation looks clean.`

**The review agent reports only — it does NOT fix code.**

### 5. Pipeline Exit (only when documentId provided)

Post findings as issue comment:
```
forge_comments → create → { data: { body: "<review output>", issue: "<documentId>", author: "Lapras" } }
```

- **No Bug findings** → Check if the branch has been pushed: `git log origin/<branch> --oneline -1`. If pushed → `forge_issues → update → { data: { status: "deploying" } }`. If NOT pushed (subagent/standalone review before push) → do not change status, just post the review comment.
- **Has Bug findings** → `forge_issues → update → { data: { status: "reopen" } }`, comment serves as rejection. Forge-fix picks it up.

## Review-specific output reminder

Findings go to `forge_comments.create`, NOT to chat. Don't print the review table twice. (See pipeline preamble for general output rules.)
