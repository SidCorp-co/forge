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

Detect tech stack from changed files, then load only what applies:
- Strapi files (`content-types/`, `controllers/`, `services/`) → read `.claude/skills/strapi/SKILL.md`
- Next.js files (`app/`, `components/`, `next/` imports) → read `.claude/skills/nextjs/SKILL.md`
- Also read `forge/.forge/lessons.md` if it exists — past gotchas to check against

### 3. Review Checklist

**Bugs & Logic** — wrong logic, null risks, race conditions, missing error handling
**Security** — injection, credentials in code, missing auth, unsanitized input
**Performance** — N+1 queries, unnecessary re-renders, memory leaks, unbounded data
**TypeScript** — unsafe casts, `any` leaks, missing type narrowing
**React** (if applicable) — wrong useEffect deps, unmounted state updates, unstable keys
**Strapi** (if applicable) — document service usage, lifecycle loops, missing populate
**Consistency** — matches project patterns, web/dev parity if both changed

**UI behavior (when applicable)** — for any change touching `web`/`dev`/`app`/`widget` UI, if the calling agent has the Playwright MCP available (`mcp__playwright__browser_*` tools), navigate to the affected page on the running deploy and walk through each `acceptanceCriteria` line with `browser_navigate` + `browser_click` + `browser_evaluate` asserting expected post-state. Screenshot the final state for evidence. A static code review alone is insufficient for UI work — controlled-input bugs, focus order, scroll behavior, sticky headers, paging UI, and toast timing are routinely missed by diff inspection. If Playwright MCP isn't available in the host agent, note `e2e-not-verified` in the review summary so downstream verify steps can decide.

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
