# Plan Format

The plan field is the primary artifact of this skill. It's read by:
- **forge-code** — follows it step-by-step during implementation
- **Humans** — review it for complex issues before approving
- **forge-review** — compares the actual diff against the plan to catch scope creep

Write it so all three audiences can use it without needing additional context.

## Template

```markdown
## Approach
<1-3 sentences: what's the solution strategy and why this approach over alternatives>

## Affected Files
- `path/to/file.ts` — <what changes and why>
- `path/to/other.ts` — <what changes and why>

## Implementation Steps
1. <concrete action with file path> — <why this step>
2. <concrete action with file path> — <why this step>
...

## API Test Plan
<Only include if the change affects backend API endpoints. Omit entirely for frontend-only changes — frontend testing is handled by QA (forge-test).>

1. **<Test name>**
   - `<METHOD> <path>` — <body/params if any>
   - Expected: <status code> + <key response fields and values that QA will verify>
   - Example: `curl -X POST http://localhost:1337/api/... -H 'Authorization: Bearer $TOKEN' -d '...'`

## QA Scenarios
<Test scenarios for forge-test to execute against the preview/staging deployment.
Each scenario = Setup → Action → Verify → Contrast (optional).>

1. **<Scenario name>** (AC #N)
   - Setup: <preconditions — which role to login as, any time/date override, data needed>
   - Action: <what to do — navigate to page, click button, call API>
   - Verify: <expected result — element visible/hidden, no dialog, correct response>
   - Contrast: <opposite case that proves the logic — e.g., same action with different role/time should produce different result>

## Risks
- <non-obvious risks or edge cases> (omit section entirely if none)
```

## Writing Good Plans

**Approach section** — explain the *why*, not just the *what*. "Add a `maxEntries` parameter to the log hook and evict oldest entries when exceeded" is better than "fix the memory issue". If you considered alternatives, briefly note why you chose this one.

**Affected Files** — list every file that needs modification. Missing a file here means the coding agent won't know to touch it. Include files for types, tests, and any re-exports. Order them by implementation sequence when possible.

**Implementation Steps** — each step should be one atomic change. Include:
- The file path (so the coding agent can jump straight to it)
- What to change (add function, modify type, update import)
- Why (connects back to the acceptance criteria)
- Pattern to follow (if similar code exists elsewhere, reference it: "follow the pattern in `use-issues.ts` line 45")

**API Test Plan** — only include for changes that touch backend API endpoints, controllers, or services. Each test should specify the endpoint, method, request body, **and the expected response** (status code + key fields/values). The expected output is the contract that QA will later verify — forge-code confirms the API returns exactly what QA expects. Include a curl example so forge-code can run it against the local dev server. **Omit entirely for frontend-only changes** — frontend testing is handled by QA (forge-test).

**QA Scenarios** — these are consumed by `forge-test` which executes them against the live preview/staging deployment using browser automation and API calls. Each scenario follows the pattern:
- **Setup**: preconditions (role, time override, data state). Be specific: "Login as Employee (tuyendtb@canawan.com)" not just "login as employee".
- **Action**: concrete user steps. "Navigate to /attendance → Click Clock Out" not "test clockout".
- **Verify**: expected observable result. "No warning dialog appears" not "works correctly".
- **Contrast** (optional but valuable): the opposite case that proves the logic isn't broken. If the fix hides something for Role A, the contrast tests that Role B still sees it. If the fix changes behavior on Saturday, the contrast tests that weekday behavior is unchanged.

Write scenarios from the **user's perspective**, not implementation details. forge-test doesn't have codebase access — it can only see what a user sees in the browser or API response.

**Risks** — only include if there are genuine concerns. Empty risks sections train readers to ignore them. Things worth flagging: breaking changes to shared types, migration requirements, performance implications for large datasets, features that need both web and dev changes for parity.

## Anti-Patterns

- **Vague steps** — "Update the component" tells the coding agent nothing. Which component? What change? What's the expected behavior?
- **Missing file paths** — "Add a new hook" without specifying where it should live forces the coding agent to make architectural decisions it shouldn't
- **Over-planning** — don't specify exact variable names, line numbers that will shift, or implementation details better left to the coder. The plan is a map, not a GPS turn-by-turn
- **Copy-pasting the issue** — the plan should add value beyond what's already in the description and acceptance criteria. If you're just restating them, the plan isn't useful
