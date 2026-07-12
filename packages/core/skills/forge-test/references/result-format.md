# Test Report Format

Post the report as an issue comment via `forge_comments → create`.

## Template

```markdown
**QA Test Report**

| # | Test Case | Source | Result | Notes |
|---|-----------|--------|--------|-------|
| 1 | Description of what was tested | AC #1 | PASS | How it was verified |
| 2 | Description of what was tested | AC #2 | FAIL | What went wrong |
| 3 | Description of what was tested | Desc | SKIP | Why it was skipped |

**Summary:** X/Y passed
**Verdict:** PASS / FAIL
```

## Column Guide

- **Test Case** — what was tested, in plain language ("User can drag issues between columns")
- **Source** — where the test case came from: `AC #1` (acceptance criteria), `Desc` (description), `Plan` (testing strategy)
- **Result** — `PASS`, `FAIL`, or `SKIP`
- **Notes** — brief evidence. For PASS: how verified. For FAIL: what happened instead. For SKIP: why.

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

- **PASS** — all test cases pass. No FAIL results.
- **FAIL** — one or more test cases failed. Include actionable failure details so forge-fix knows exactly what to address.
- SKIPped tests don't affect the verdict (they indicate untestable criteria, not failures).
