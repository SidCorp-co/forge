# Test Report Format

Post the report as an issue comment via `forge_comments → create`.

## Template

```markdown
**QA Test Report**

| # | Test Case | Source | Result | Notes |
|---|-----------|--------|--------|-------|
| 1 | Description of what was tested | AC #1 | PASS | How it was verified |
| 2 | Description of what was tested | AC #2 | FAIL | What went wrong |
| 3 | Required fixture is unavailable | AC #3 | BLOCKED_FIXTURE | `resultReason`: fixture and access needed |
| 4 | Automated evidence covers the criterion | Plan | VERIFIED_BY_TEST | `resultReason`: test evidence and why live verification could not run |

**Summary:** X/Y directly verified
**Verdict:** PASS / FAIL / BLOCKED_FIXTURE / VERIFIED_BY_TEST
**Result reason:** Required for BLOCKED_FIXTURE and VERIFIED_BY_TEST.
```

## Column Guide

- **Test Case** — what was tested, in plain language ("User can drag issues between columns")
- **Source** — where the test case came from: `AC #1` (acceptance criteria), `Desc` (description), `Plan` (testing strategy)
- **Result** — `PASS`, `FAIL`, `BLOCKED_FIXTURE`, or `VERIFIED_BY_TEST`
- **Notes** — brief evidence. For PASS: how verified. For FAIL: what happened instead. For BLOCKED_FIXTURE or VERIFIED_BY_TEST: include `resultReason`.

## Failure Detail

When any test fails, add a **Failures** section below the table, framed as `Expectation → Observation → user impact → fix`:

```markdown
**Failures:**

**#2 — Mobile horizontal scroll (AC #3):**
Expectation: swipeable horizontal layout per acceptance criteria.
Observation: on viewport 375px, board columns stack vertically instead of scrolling horizontally.
Impact: primary board navigation is unreachable on mobile.
Fix: restore the horizontal scroll container at the narrow breakpoint.

**API response:** (include relevant snippet if backend test)
```

## Verdict Rules

- **PASS** — all required test cases pass through direct verification.
- **FAIL** — one or more executed test cases failed. Include actionable failure details so forge-fix knows exactly what to address.
- **BLOCKED_FIXTURE** — a required criterion cannot be exercised because its fixture or resource is unavailable. Include `resultReason`; this is not PASS and the issue must park at `waiting` with `waitingKind: "needs_resource"` and a non-empty transition reason.
- **VERIFIED_BY_TEST** — automated evidence verifies a required criterion, but direct/live verification cannot run. Include `resultReason`; this is not PASS and the issue must park at `waiting` with `waitingKind: "needs_decision"` and a non-empty transition reason.
- Do not record an unwalkable required criterion as SKIP. Use BLOCKED_FIXTURE or VERIFIED_BY_TEST instead.
