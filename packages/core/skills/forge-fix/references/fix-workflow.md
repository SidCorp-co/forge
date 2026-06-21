# Fix Workflow

## Core Principle

Fix what the feedback says, nothing more. The plan was already approved and the code was already reviewed — expanding scope during a fix cycle introduces new bugs and triggers infinite review loops.

## Parsing Rejection Feedback

### From Code Review (forge-review)

Starts with `## Code Review`. Contains a severity table:

```
| # | File | Line | Severity | Finding |
```

- **Bug** — must fix. Incorrect behavior.
- **Minor** — should fix. Problematic pattern.
- **Low** — skip unless trivial. Style/naming.

Fix Bug and Minor items. Skip Low unless it's a one-line change.

### From QA Report (forge-test)

Starts with `**QA Test Report**`. Contains a pass/fail table:

```
| # | Test Case | Source | Result | Notes |
```

Look at FAIL rows. The **Notes** column and **Failures** section describe what went wrong. Each failed test case = one fix task.

### From CI Build Failure

Starts with `**Preview deploy failed**`. Contains build output in a code block. Parse the error — usually a compile error, missing import, or test failure.

## Branch Handling

First confirm current git state — in pipeline-resumed sessions the working tree may be on an unexpected branch from a previous step:

```bash
git branch --show-current
git status
```

If dirty, stash uncommitted changes: `git stash`.

Always fix on the ISS-* feature branch (never directly on baseBranch). The ISS-* branch is kept alive through the pipeline as the single source of truth — forge-release squash-merges it to the production branch at the end.

```bash
git checkout ISS-XX-*
git pull origin ISS-XX-*
```

If multiple matches, pick the one for this issue number. If no branch found:
```bash
git fetch origin
git branch --list 'ISS-*' | grep <issue-number>
```

After fixing and committing, push ISS-*. In **deploy mode** (Coolify or staging URL), merge the fix into `baseBranch` (staging) for **every** complexity, then deploy — same as the code step, so the re-verify environment has the fix:
```bash
git push origin ISS-XX-short-title
git checkout <baseBranch> && git merge ISS-XX-short-title && git push origin <baseBranch>
git checkout ISS-XX-short-title
```
In **local-only mode**, push the ISS-* branch only — no merge, no deploy. (Decompose child/parent target the integration branch, not `baseBranch` — see decompose-execution.md.)

## Fix Strategy

For each finding:
1. Read the affected file at the mentioned line
2. Understand the surrounding context (read 20-30 lines around it)
3. Apply the minimal fix that addresses the finding
4. Move to the next finding

**Do not:**
- Refactor adjacent code that wasn't mentioned
- Add new features or "improvements"
- Change the overall approach or architecture
- Touch files that aren't related to the findings

## Build + Test Before Push

After all fixes applied:
1. Build the affected package(s) — infer the build command from the repo — verify no compile errors
2. If API endpoints were changed: curl affected endpoints to verify responses
3. Fix any failures before pushing

Frontend testing is handled by QA (forge-test) against the preview deployment — don't run the frontend unit-test runner for frontend-only fixes.

## Commit Convention

Separate fix commit — never amend or squash into the original:

```bash
git add <specific files>
git commit -m "fix: address review feedback — <1-line summary>"
git push
```

## When Feedback is Unclear

If the rejection comment doesn't provide enough detail to understand what to fix:
- Post a clarifying comment asking specific questions
- Set `status: needs_info`
- Stop — don't guess at fixes
