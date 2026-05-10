---
name: forge-review
description: "Solo TBD verify-and-ship pipeline for Forge Dev. In pipeline mode (developed → closed): runs review, simplify, unit tests, e2e (if UI), squash-merges ISS-* to main, pushes, closes the issue. In subagent/standalone mode: review-only as before. Triggers on: /forge-review, reviewing code, verifying issue, finishing issue, merging to main."
user_invocable: true
arguments: "[documentId]"
---

# Forge Review (Solo TBD verify + ship)

Project-scope override for Forge Dev. Replaces the default review-only step with a full local verify pipeline so solo TBD work auto-merges to main when everything is clean.

Three modes:
- **Pipeline mode** (`/forge-review <documentId>`) — verify → merge main → close. This is what the worker runs at status `developed`.
- **Subagent mode** — spawned by forge-code during its build step. Review-only, returns findings.
- **Standalone mode** (`/forge-review` no args) — review current branch diff, no status change.

## Pipeline mode (documentId provided)

### 1. Load issue + branch

```
forge_issues → get → { documentId }
```

Capture: `category`, `title`, branch name `ISS-<id>-<short>`, current status (must be `developed`).

```bash
git fetch origin
git checkout ISS-XX-...
git status   # must be clean — if dirty, stop, post comment, set status reopen
```

### 2. Verify — fail-fast, comment-on-fail

Each sub-step on fail: post a comment with the failing output (truncated to ~80 lines), set `status=reopen`, exit. `forge-fix` will pick it up.

#### 2a. Code review

Spawn `pr-review` subagent with the branch diff (`git diff main...HEAD`). It returns severities. Treat any **Bug** finding as fail → reopen with the review table as comment body.

If only **Minor**/**Low** → continue, but include the review table in the final success comment.

#### 2b. Simplify

```
Skill → simplify
```

The `simplify` skill checks reuse/quality/efficiency on changed files and may auto-fix. If it makes commits, include them in the merge. If it reports unfixable issues with severity ≥ medium → reopen with its report.

#### 2c. Source-language scan

The pre-commit hook + CI `lang-check` job should already have caught any non-English UI strings, but the verify-and-ship pipeline scans defensively to catch hooks bypassed via `SKIP_LANG_CHECK=1`.

```bash
node scripts/check-source-language.mjs --all
```

If the script exits non-zero: post a comment with the script output (truncate to ~80 lines), set `status=reopen`, exit. `forge-fix` will pick it up. The failure comment must include the offending `file:line:snippet` rows verbatim and a one-line action: `Translate to English, or add an i18n-allow: directive with a reason if intentional.`

#### 2d. Unit tests

Detect changed packages:

```bash
git diff --name-only main...HEAD | awk -F/ '/^packages\// { print $2 }' | sort -u
```

For each package in the result, run:

```bash
cd /home/kieutrung/tools/forge/jarvis-agents/packages/<pkg>
npx vitest run --reporter=dot
```

Any non-zero exit → reopen with the failing test names + first failure stack.

#### 2e. E2E with Playwright MCP — MANDATORY for UI changes

**Trigger**: any of these touched in the diff →
- `packages/web/**` (Next.js cloud UI)
- `packages/dev/**` (Tauri renderer)
- `packages/app/**` (Expo mobile)
- `packages/widget/**`
- Any UI-visible string in `packages/core/**` (toasts, error messages, response copy)

**Skip ONLY** when the change is purely server-internal (DB schema, MCP tool internals, jobs, dispatcher, schedules) AND the issue's `acceptanceCriteria` contains no user-visible verb (`render`, `display`, `show`, `toast`, `badge`, `click`, etc.). When in doubt → run.

**Target URL**:
- Forge Dev project verifies against the deployed beta: `https://forge-beta.sidcorp.co`
- The latest `main` push has typically deployed within ~3 minutes; if the verify pipeline runs <5 min after push, wait until the new commit hash is live (probe `https://forge-beta.sidcorp.co/api/health` or the deploy log) before testing.
- Local dev server is the fallback if beta isn't reachable: `cd packages/web && npm run dev`, target `http://localhost:3000`. Local needs `NEXT_PUBLIC_API_URL` overridden to the beta API for data parity.

**Procedure** — use the Playwright MCP tools (`mcp__playwright__browser_*`) DIRECTLY in this verify step. Do NOT delegate to the `e2e-playwright` skill subagent for the gate decision; that skill is for writing persisted tests, not the live pass/fail check here.

**Pre-auth (mandatory before the per-AC loop)**: follow `lib/playwright-auth.md` — log the test user in via the UI form using `FORGE_E2E_EMAIL` / `FORGE_E2E_PASSWORD`, then health-check `window.location.pathname` after navigating to `/projects/forge-dev`. Missing env, login timeout, or a `/login` pathname after the health check → fail gate, set `status=reopen`. Do NOT proceed to AC checks without an authenticated session.

**401 / re-login policy**: on any 401 response (visible via `mcp__playwright__browser_network_requests`) or unexpected `/login` redirect during AC checks, re-run the pre-auth procedure once and retry the failing step. A second 401 → fail gate with the request log.

For each line in the issue's `acceptanceCriteria`:
1. **Translate to a concrete browser action**. Example AC: `Checkbox column visible on issues list, supports shift-click range select` → navigate to `/projects/<slug>/issues`, run `browser_evaluate` to assert `document.querySelector('input[type=checkbox]')` exists, click 2 boxes with shift modifier, assert both checked.
2. **Run the action** via `mcp__playwright__browser_navigate` / `_click` / `_evaluate` / `_fill_form` / `_press_key`.
3. **Assert** post-state via `mcp__playwright__browser_evaluate` returning a verdict object. Visual asserts (text appears) → use `mcp__playwright__browser_wait_for` with the text + `_snapshot` to confirm.
4. **Screenshot** the final viewport with `mcp__playwright__browser_take_screenshot` named `iss-<id>-ac-<n>.png` for the success case; on fail, also screenshot the broken state.
5. **Console check**: after the AC pass, read `mcp__playwright__browser_console_messages` — any `error` level message that's not pre-existing (compare against a baseline navigation to a known-good page) → report as a verify failure even if the AC technically passed.

**Pass criterion**: every AC line maps to at least one passing action+assert pair. ACs without a clear UI verb (e.g. `Migration runs cleanly`) are skipped at this step but logged so the reviewer knows they were not gated.

**Fail handling**:
- If any AC assert fails → reopen with comment containing: AC text verbatim, the action attempted, the actual vs expected, and the failure screenshot path. Include the console error log if any.
- **Auth wall after pre-auth has run** → the test creds are stale or the session was rejected. Fail the gate, post a comment naming the missing/failing `FORGE_E2E_*` var (or the response status from the login POST), and set `status=reopen`. Do NOT use `on_hold` for this case — `on_hold` is reserved for genuinely human-only blockers below.
- If the page is unreachable for a human-only reason (deploy not live yet, 500 from API, third-party outage) → DO NOT pass-by-default. Post a comment listing the blocker and set `status=on_hold` for human triage. Pipeline must not silently skip the gate.
- If Playwright MCP itself isn't available in the agent's tool list → fail open with a comment `Playwright MCP unavailable, e2e gate skipped — re-run /forge-review when MCP is connected.` Do NOT pass without verification; leave at `developed`.

**Negative-case spot check** (when AC implies state changes): for the first state-mutation AC, also attempt one negative case (e.g. unauthenticated request, malformed input) and confirm graceful handling. Two-minute time budget; if no obvious negative case, skip.

Any failing scenario → reopen with the verbatim AC + action log + screenshot reference.

### 3. Merge to main (squash)

All verify steps passed. Merge:

```bash
git fetch origin main
git checkout main
git pull --ff-only origin main
git merge --squash ISS-XX-...
git commit -m "$(cat <<EOF
ISS-XX: <issue title>

<one-paragraph summary of what changed, derived from issue description + commits>

Closes ISS-XX
EOF
)"
git push origin main
```

If the squash merge has conflicts: stop, post comment with the conflict list, `status=on_hold` (NOT reopen — needs human, forge-fix can't resolve conflicts mid-merge).

### 4. Clean up branch

```bash
git branch -D ISS-XX-...
git push origin --delete ISS-XX-...
```

Branch delete failure is non-fatal — log and continue.

### 5. Walk status to closed (short path)

The desktop worker only handles `plan/code/review/fix/triage` job types — `test`/`release` jobs fail with `unsupported job type` and pollute the Activity tab. Walking through `testing` or `released` always spawns those failing jobs because the orchestrator's `considerEnqueue` runs on every status change regardless of whether the worker can service it.

Take the 2-hop shortcut instead. `on_hold` and `closed` are both absent from `STATUS_TO_SKILL`, so neither transition spawns a job:

```
developed → on_hold → closed
```

Use `forge_issues → update`:

1. `{ documentId, data: { status: "on_hold" } }` — allowed from `developed` (state-machine.ts:16)
2. `{ documentId, data: { status: "closed" } }` — allowed from `on_hold` (line 25, on_hold can resume to any status)

Two update calls. The brief `on_hold` step is intentional and noted in the final comment so it's clear from changeHistory why the issue paused for one tick.

### 6. Final comment

```
forge_comments → create → {
  data: {
    body: "**Verified + shipped to main.**\n\n- Review: <N minor / clean>\n- Simplify: <N changes / clean>\n- Unit tests: <packages, all pass>\n- E2E: <scenarios pass / skipped — backend-only>\n- Merge: squash <commit-sha> to main\n- Branch: deleted\n- Status walk: developed → on_hold → closed (short path; skips testing/released to avoid spurious test/release jobs the desktop worker doesn't service)\n\nIssue closed.",
    issue: documentId,
    author: "Lapras"
  }
}
```

## Subagent mode (no documentId, called from forge-code)

Identical to original forge-review review-only flow:
1. `git diff HEAD~N` — N = implementation commits
2. Run review checklist (Bugs/Security/Performance/TS/React/Strapi/Consistency)
3. Return the findings table to the caller. Do NOT post comments. Do NOT change status.

## Standalone mode (`/forge-review` with no args)

`git diff main...HEAD` → review checklist → print findings table to chat. No comments, no status changes.

## Output Rules

- **Zero narration during verify.** No "running tests now…" chatter. The user reads the final comment.
- **One-line status only at the end.** "Verified + shipped: 0 bugs, 0 test failures, merged abc1234." or "Reopened: 1 bug at simplify step."
- **Failure comments must be actionable.** Include the exact failing command output (truncate to ~80 lines), the file:line, and a one-line hypothesis. forge-fix reads these.
