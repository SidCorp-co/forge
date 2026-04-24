# Triage Criteria

The core question: **can a developer (or coding agent) understand what to change and what the result should be?**

Triage exists to catch incomplete issues *before* they reach expensive downstream steps like planning and coding. An issue that bounces back with questions wastes an entire plan-code-review cycle. Getting this right here saves the most time.

## All Issues Must Have

1. **Clear scope** — what area of the system is affected (feature, page, API, component)
2. **Expected outcome** — what should be true after the change
3. **Enough context** — sufficient detail to start without guessing

These three form the minimum bar. If any is missing, the developer will either guess wrong or come back with questions — both waste time.

## Bug-Specific Requirements

Bugs need at least ONE of:
- Steps to reproduce
- Observable symptom (error message, screenshot, wrong behavior)
- Specific conditions (browser, device, data state)

Why at least one: a developer can investigate a bug from any of these starting points, but with none of them, they're debugging blind.

"Login is broken" → `needs_info` (which login? what happens? when?)
"Login returns 500 when email contains a + character" → actionable

## Feature-Specific Requirements

Features need at least ONE of:
- User-facing description of the desired outcome
- Acceptance criteria that define "done"
- Suggested solution detailed enough to derive expected behavior

Why: features without a clear "done" state lead to scope creep or the wrong thing being built. Any of these anchors the work.

"Improve the dashboard" → `needs_info` (improve how? which metrics? for whom?)
"Add a filter dropdown to the issues list that filters by priority" → actionable

## When to Confirm vs Needs Info

**Confirm** when:
- You can roughly describe what areas would need to change
- Expected behavior is clear enough to verify when done
- Acceptance criteria exist (author-written OR AI-generated) that define success

**Needs Info** when:
- Scope is too broad to plan ("improve performance")
- Multiple valid interpretations exist — choosing wrong wastes effort
- Cannot determine what "done" looks like
- Missing critical context (which page? which endpoint? which user role?)

The threshold is intentionally low for confirming. Triage doesn't need to prove the issue is perfectly specified — just that a developer won't be stuck on page one. The `forge-plan` step does deeper analysis with codebase access.

## Edge Cases

- **AI-generated criteria** (`aiAcceptanceCriteria`, `aiSuggestedSolution`) count as sufficient detail, even if the human description is vague. The system generated these from the original description, so if they make sense, treat them as valid.
- **Plan already populated** — if the `plan` field has content, the issue is past triage. Confirm immediately.
- **Short but clear** — "Fix typo: 'Submited' → 'Submitted' on settings page" is one line but fully actionable. Length ≠ quality.
- **References external context** — if the issue mentions a Slack thread, screenshot, or PR without including the content, ask for the relevant details to be inlined. External references go stale.
