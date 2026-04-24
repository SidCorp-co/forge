---
name: forge-test
description: "QA test Forge issue changes against preview deployments. Use this skill to test like a human QA — hitting the preview backend API and navigating the preview frontend to verify acceptance criteria are met. Triggers on: /forge-test, testing an issue, QA testing, verifying changes on preview, checking if acceptance criteria pass. Also use when the pipeline needs to verify changes at testing status."
user_invocable: true
arguments: "documentId"
---

# Forge Test

Automated QA agent that tests the issue's actual output against the preview or staging deployment — like a human tester would. Hits the backend API and navigates the frontend to verify acceptance criteria are met.

This is NOT a test runner (vitest/playwright). It's a manual QA replacement that uses live URLs to verify the change works end-to-end.

## Usage

```
/forge-test <documentId>
```

## Tools

- **forge_issues** — get issue data (acceptance criteria, preview URLs, plan, changeHistory)
- **forge_comments** — list previous comments (review/fix feedback) + post test report
- **forge_config** — get project config (staging URLs, test credentials)
- **forge_coolify_deploy** — check deployment status before testing
- **Browser** — `mcp__claude-in-chrome__*` for frontend testing
- **HTTP** — WebFetch / Bash (curl) for API testing

Read `references/test-approach.md` for detailed testing patterns (API auth, browser tools, what to verify). Read `references/result-format.md` for report template and verdict rules. Read `references/browser-playbook.md` for step-by-step browser interaction guides (login, navigation, form input, code inspection) — follow these exactly to avoid rediscovering UI flows.

## Workflow

### Step 0: Local-only mode guard

Call `forge_config → get` and `forge_coolify_deploy → list`. If `previewDeploy` is null/missing AND Coolify list is empty → project is in **local-only mode**.

In local-only mode there is no preview/staging deployment to QA against. The build + unit tests already ran in `forge-code` / `forge-fix`. Post a comment and exit without changing status:

```
forge_comments → create → {
  data: {
    body: "**QA skipped** — project is in local-only mode (no Coolify, no preview URL). Build and unit tests were executed by forge-code/forge-fix. The pipeline ends at `developed` for human review; the human closes the issue manually. Skip forge-test.",
    issue: "<documentId>",
    author: "Machamp"
  }
}
```

Stop. Do NOT call `forge_issues → update`.

### Step 1: Fetch Issue + Pipeline Context

```
forge_issues → get → { documentId: "<id>" }
forge_comments → list → { filters: { issue: "<id>" } }
```

Read from issue: title, description, acceptanceCriteria, aiAcceptanceCriteria, plan, previewUrl, previewApiUrl, changeHistory.

Read from comments: triage report, review findings, previous QA reports, fix notes.

### Step 2: Detect Reopen Cycle

Check `changeHistory` for previous `testing → reopen` transitions.

- **First test (no prior reopen):** test all acceptance criteria normally.
- **Reopen cycle (prior QA failure exists):** find the most recent QA Test Report comment. Extract the FAIL items — these are **mandatory regression tests** that must pass this time. Also re-test all other acceptance criteria.

### Step 3: Wait for Deployment Readiness

Before testing, ensure the deployed code is up to date. Deployments triggered by upstream skills (forge-code, forge-fix, forge-staging) may still be building when this step starts.

```
forge_coolify_deploy → status → {}
```

Check the most recent deployment for each resource:
1. If the most recent deployment was created within the last 5 minutes and status is still in-progress/building → **wait 60 seconds**, then re-check
2. Repeat up to 3 times (~3 min max wait)
3. If deployment is complete or no recent deployment found → proceed immediately
4. If still building after 3 retries → proceed but add a note to the test report: "Warning: Coolify deployment may still be in progress. Results may reflect stale code."

If no Coolify resources are configured, skip this step.

### Step 4: Get Test URLs & Credentials

Fetch project config via `forge_config → get`. This returns `previewDeploy` with `stagingUrl`, `stagingApiUrl`, and `testCredentials`.

**URL resolution (issue preview takes priority, staging as fallback):**
- `testUrl` = issue `previewUrl` ?? project `previewDeploy.stagingUrl`
- `testApiUrl` = issue `previewApiUrl` ?? project `previewDeploy.stagingApiUrl`

**If both testUrl and testApiUrl are null** → post comment "No preview or staging deployment found, cannot test", stop.

Use `previewDeploy.testCredentials` (array of `{label, username, password}`) for authenticated flows. Pick the credential that matches the test scenario (e.g., "Employee" account for employee-role tests).

### Step 5: Build Test Cases

Test cases come from **upstream pipeline steps** — forge-test executes, it doesn't invent.

**Source 1 — Plan QA Scenarios (primary):**
Read the `plan` field and find the `## QA Scenarios` section. Each scenario has Setup → Action → Verify → Contrast. Execute these directly — they were written by forge-plan which has codebase context. Tag as `Plan` source.

**Source 2 — Acceptance Criteria (fill gaps):**
If the plan has no QA Scenarios section, or if some AC items aren't covered by scenarios, derive test cases from acceptance criteria:
- "User can X" → navigate to feature and do X
- "Y should display Z" → navigate to Y and verify Z is visible
- "API returns X when Y" → call API with Y and check response
Tag as `AC #N` source.

**Source 3 — Review findings (from comments):**
If forge-review posted findings, check if any were flagged as concerns. Tag as `Review` source.

**Source 4 — Reopen regression (from comments):**
If this is a reopen cycle, extract FAIL items from the previous QA report. These are mandatory regression tests that MUST pass. Tag as `Regression` source.

### Step 6: Test Backend API

For each backend-related test case:
- Authenticate with appropriate test credential via `POST {testApiUrl}/api/auth/local`
- Construct requests against `testApiUrl`
- Use WebFetch or curl to hit endpoints
- Verify: status codes, response shape, data correctness
- Test with **multiple roles** when the AC involves role-based behavior

### Step 7: Test Frontend UI

For each frontend-related test case:
- Navigate to `testUrl` using `mcp__claude-in-chrome__navigate`
- Login with the appropriate test credential for the scenario
- Follow the user flow from acceptance criteria
- Verify elements present, interactive, correct data
- Use `mcp__claude-in-chrome__read_page` to check content
- Use `mcp__claude-in-chrome__form_input` for interactions
- **Visual check:** look for broken layouts, overlapping elements, missing styles, console errors, blank sections, misaligned content, or any UI corruption. Report these as FAIL even if the feature works functionally.

**If no browser tools available:** use curl/WebFetch to fetch the page HTML and verify key elements are present/absent. Note in the report that testing was HTML-only (no interactive browser).

### Step 8: Post Test Report

```
forge_comments → create → {
  data: {
    body: "<test report>",
    issue: "<documentId>",
    author: "Forge QA"
  }
}
```

Report format:

```markdown
**QA Test Report** {cycle indicator if reopen: "(Cycle 2)"}

**Test environment:** {testUrl} (preview|staging)

| # | Test Case | Source | Result | Notes |
|---|-----------|--------|--------|-------|
| 1 | Description | AC #1 | PASS/FAIL | Details |
| 2 | Edge case from plan | Plan | PASS/FAIL | Details |
| 3 | Previous failure regression | Regression | PASS/FAIL | Details |

**Summary:** X/Y passed
**Verdict:** PASS / FAIL
```

See `references/result-format.md` for full template and failure detail format.

### Step 9: Set Status

**Status update must be the LAST action.** It triggers downstream pipeline steps.

- **All pass** → `forge_issues → update → { data: { status: "tested" } }`
- **Any fail** → `forge_issues → update → { data: { status: "reopen" } }` + detailed failure report with actionable info for forge-fix

## Output Rules (Save Tokens)

- **Zero narration.** Don't announce each test case before running it. Just execute and collect results.
- **Report goes to the comment, not to chat.** Don't print the report in conversation AND post it — that doubles tokens.
- **One-line status only.** "QA done: 5/6 passed, 1 FAIL. Set reopen." — nothing more.