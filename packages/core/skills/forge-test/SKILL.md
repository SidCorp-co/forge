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
- **Browser (optional)** — if a browser-automation MCP is available, use whatever browser tools the runner exposes (auto-detected; usually surfaced as `browser_*`: navigate, click, type, snapshot/screenshot). Do not hardcode a provider. If no browser MCP is available, fall back to curl/WebFetch HTML checks.
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

### Step 0.5: Docs-only deliverable guard

If the issue's change is a **no-code deliverable** (a `docs/proposals/<topic>.md` decision/audit/spike artifact) — detect mechanically: the diff for the issue's branch touches **only `docs/**`** (no `packages/**`) — there is no UI/API to QA. Do NOT try to walk acceptance criteria as a browser flow; that would FAIL on a doc that has no runtime surface and bounce the issue back into a loop.

Instead verify the **artifact**: confirm the planned `docs/proposals/<topic>.md` exists, is non-trivial (the actual decision/rationale/recommendations, not a stub), and is indexed in `docs/proposals/README.md`. PASS on presence + substance. Post the report and set status as usual (Step 9). If any `packages/**` file is in the diff, this is not docs-only — run the normal QA below.

### Step 0.6: Decompose-aware guard (epic child vs parent integration)

If the issue has `metadata.branchConfig` or `metadata.useIntegrationBranch`, it is part of a decomposed epic — QA behavior differs. **Read `.claude/skills/forge-plan/references/decompose-execution.md` and follow the forge-test section.** In short: a **child** is not deployed individually (no per-child preview), so don't FAIL it for lacking one — note "verified via build+review; e2e deferred to parent" and advance it; its merge target is the integration branch (`mark_merged target:'feature'`), never base/deploy. The **parent** (`useIntegrationBranch`) is where the assembled epic gets its real end-to-end QA, and is the only issue that promotes the integration branch to base. For a non-decompose issue (no such metadata), ignore this step.

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
- Authenticate via the project's login flow using credentials from `previewDeploy.testCredentials` (match by label); don't hardcode the auth endpoint — it varies by stack
- Construct requests against `testApiUrl`
- Use WebFetch or curl to hit endpoints
- Verify: status codes, response shape, data correctness
- Test with **multiple roles** when the AC involves role-based behavior

### Step 7: Test Frontend UI — functional AND quality

Drive `testUrl` with the project's wired browser MCP. Test in two passes — a feature that *works* but ships broken UX is still a FAIL.

**Pass A — Functional flow (per test case):**
- Navigate, login with the appropriate test credential for the scenario, walk the user flow from the acceptance criteria.
- Verify elements are present, interactive, and show correct data (snapshot/read the page, fill forms, click through).
- Watch the console: any error thrown during the flow is a FAIL even if the screen looks fine.

**Pass B — UX & accessibility quality bar (every screen the change touches):**
Run the **Pass-B quality checklist** (`references/ui-quality-checklist.md`) over each affected screen. The bar is "would you ship this to a user", not "does the element exist". Cover, and record a verdict for each:
- **Responsive** — re-check the flow at narrow / medium / wide viewports; layout must not break, overflow, or hide primary actions at the narrow width.
- **States** — exercise the **empty, loading, and error** states of any list / form / async surface the change touches — not just the happy path. A missing empty/error state is a FAIL.
- **Accessibility** — every new interactive element reachable and operable by keyboard alone; icon-only controls and inputs have accessible labels; text legible and not conveyed by colour alone.
- **Role correctness** (if the project has roles) — controls a role may not use are hidden/disabled, not just unenforced; no other tenant's/user's data leaks onto the screen.
- **Design consistency** — matches the app's existing components, spacing, and typography; no ad-hoc one-off styling.

Tag quality failures distinctly (`UX` / `A11y` / `Responsive`) so forge-fix can triage severity — they are real FAILs, kept separate from functional FAILs. **Scope to the change** — audit the screens this issue adds or modifies; don't re-audit the whole app. For backend-only changes with no UI surface, skip Pass B and note "no UI surface".

**If no browser tools available:** use curl/WebFetch to fetch the page HTML and verify key elements are present/absent. Note in the report that testing was HTML-only (no interactive browser) — Pass B cannot be fully verified, say so explicitly rather than claiming PASS.

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
| 3 | Empty/error state of <surface> | UX | PASS/FAIL | Details |
| 4 | Keyboard reachability of <control> | A11y | PASS/FAIL | Details |
| 5 | Flow at narrow viewport | Responsive | PASS/FAIL | Details |
| 6 | Previous failure regression | Regression | PASS/FAIL | Details |

**Verification:** what I actually walked — which flows, at which viewports, which states/roles exercised, and what I did NOT cover. "Looks right" is not verification; name the evidence. For UI changes, attach a screenshot of the final state.

**Summary:** X/Y passed
**Verdict:** PASS / FAIL
```

`Source` ∈ `AC #N` / `Plan` / `Review` / `Regression` / `UX` / `A11y` / `Responsive`. See `references/result-format.md` for full template and failure detail format, and `references/ui-quality-checklist.md` for the Pass-B quality bar.

### Step 9: Set Status

**Status update must be the LAST action.** It triggers downstream pipeline steps.

- **All pass** → `forge_issues → update → { data: { status: "tested" } }`
- **Any fail** → `forge_issues → update → { data: { status: "reopen" } }` + detailed failure report with actionable info for forge-fix

## Test-specific output reminder

The QA report goes to `forge_comments.create`, NOT to chat. Don't print it twice. (See pipeline preamble for general output rules.)