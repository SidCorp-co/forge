# Test Approach

## Think Like a Human Tester

Read the issue from a user's perspective — what should work differently after this change? Don't test implementation details. Test observable behavior by following the user journey: navigate to the feature, perform the action, verify the result.

## Deriving Test Cases from Pipeline Context

### From Acceptance Criteria (primary)
Each acceptance criterion becomes at least one test case:
- "User can X" → navigate to the feature and do X
- "Y should display Z" → navigate to Y and verify Z is visible
- "API returns X when Y" → call API with Y and check response
- "When A happens, B should update" → trigger A, verify B changed

### From Plan (secondary)
The plan field often contains implementation details that imply testable edge cases:
- Per-role behavior → test with multiple credential roles
- Day/schedule overrides → test for specific days/conditions
- URL parameter handling → test direct URL access
- Fallback logic → test when primary path is unavailable

### From Review Comments (tertiary)
If forge-review posted findings before this reached testing, check those comments for:
- Flagged edge cases or concerns
- Security issues that were supposedly fixed
- Performance concerns that should be observable

### From Previous QA Failures (reopen cycles)
If changeHistory shows a prior `testing → reopen` transition:
1. Find the most recent "QA Test Report" comment
2. Extract all FAIL items — these are mandatory regression tests
3. Tag them as `Regression` source in the new report
4. These MUST pass for the verdict to be PASS

If no explicit acceptance criteria exist, derive from the issue description and plan.

## Backend API Testing

Use `testApiUrl` (resolved from issue `previewApiUrl` or project `stagingApiUrl`) as the base URL for all API calls.

**Tools:** WebFetch for simple requests, `Bash` (curl) for complex ones (custom headers, multipart).

**Authentication:** Authenticate via the project's own login flow using credentials from `previewDeploy.testCredentials` (match by label). Don't hardcode the auth endpoint — it varies by stack; infer the login request shape from the project's API/knowledge, obtain a token/session, then attach it to subsequent requests.

**Multi-role testing:** When the issue involves role-based behavior, authenticate with each relevant role and verify:
- The role that SHOULD see the feature → sees it
- The role that should NOT see it → doesn't see it

**What to verify:**
- Correct HTTP status codes (200, 201, 400, 404)
- Response body shape matches expected schema
- Data values are correct (not just present)
- Edge cases from acceptance criteria (empty input, invalid IDs)

## Frontend UI Testing

Use `testUrl` (resolved from issue `previewUrl` or project `stagingUrl`) as the base URL.

**With browser tools (preferred):**
- `mcp__claude-in-chrome__navigate` — open pages
- `mcp__claude-in-chrome__read_page` — verify content is visible
- `mcp__claude-in-chrome__find` — locate specific elements
- `mcp__claude-in-chrome__form_input` — fill forms, select dropdowns
- `mcp__claude-in-chrome__computer` — click buttons, scroll, take screenshots

**Without browser tools (fallback):**
- Use `curl -s "$TEST_URL/path"` to fetch page HTML
- Check for key element text, class names, or data attributes
- Note in report: "Tested via HTML inspection (no browser tools available)"

**Verification strategy:**
1. Navigate to the page where the change should be visible
2. Read the page to confirm the element/data exists (or is hidden)
3. Interact if the criterion requires an action (click, submit, drag)
4. Read the page again to verify the result
5. Take a screenshot as evidence for the report

## What NOT to Test

- Implementation details (internal state, database records)
- Unrelated features that weren't changed
- Performance benchmarks (unless in acceptance criteria)
- Things that require production data or external services not on preview/staging
