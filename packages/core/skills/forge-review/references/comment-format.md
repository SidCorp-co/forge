# forge-review comment format

Post via `forge_comments → create`. Always English.

## Single-pass template (ORDINARY diffs)

```markdown
## Code Review — ISS-XX

Reviewed SHA: `<short-sha>`
Files changed: <n> files, +<add>/-<del>

### Findings

| # | File:Line | Severity | Finding |
|---|---|---|---|
| 1 | path/to/file.ts:123 | Bug | <description + suggested fix> |
| 2 | path/to/file.ts:200 | Low | <description> |

(Empty table if clean: "No issues found. Implementation looks clean.")

### Verdict: **<APPROVE | REQUEST CHANGES | ABSTAIN>**

- APPROVE → advancing to `testing`.
- REQUEST CHANGES → transitioning to `reopen`; forge-fix applies the listed Bug findings. Non-Bug findings are recorded but do not gate the chain.
- ABSTAIN → review could not complete (`<reason>`); status stays at `developed` for human inspection.
```

Severities: **Bug** (incorrect behavior, gates verdict), **Minor** (problematic pattern), **Low** (style/naming). Definitions: see [../SKILL.md](../SKILL.md) §3.

Non-Bug findings on an APPROVE must be filed via `forge_issues.createTask` (`data.issueId` = this issue) before transitioning — forge-fix never runs after APPROVE, so an untracked finding is lost.

## Multi-vote template (HIGH-RISK diffs)

When the diff is HIGH-RISK and the multi-vote ran (see [multi-vote.md](multi-vote.md)), use
this block. The per-reviewer table + the aggregate tally make the ≥2/3 decision
reconstructable from the comment alone. The `Reviewed SHA:` marker stays mandatory.

```markdown
## Code Review — ISS-XX  (multi-vote · high-risk)

Reviewed SHA: `<short-sha>`
Files changed: <n> files, +<add>/-<del>
Risk trigger: <which predicate fired — e.g. "schema/migration: **/migrations/**" | "≥10 files" | "complexity xl">
Spawn mode: <parallel sub-agents | sequential fresh-context passes (Task tool unavailable)>

### Reviewer votes

| Reviewer | Lens | Verdict | Substantiated Bugs |
|---|---|---|---|
| 1 | correctness | clean / not-clean | <count> |
| 2 | security | clean / not-clean | <count> |
| 3 | <UI-&-flow parity \| data-integrity/migration-safety/API-contract> | clean / not-clean | <count> |

**Aggregate: <k>/3 clean → <APPROVE | REQUEST CHANGES>**

### Union of Bug findings (all reviewers)

| # | File:Line | Lens | Finding |
|---|---|---|---|
| 1 | path/to/file.ts:123 | security | <description + mechanism + suggested fix> |

(Empty table if all reviewers clean: "No substantiated Bugs across 3 lenses.")
Out-voted Bugs on an APPROVE are filed via `forge_issues.createTask` (noted here).

### Verdict: **<APPROVE | REQUEST CHANGES | ABSTAIN>**

- APPROVE (≥2/3 clean) → advancing to `testing`.
- REQUEST CHANGES (<2/3 clean) → transitioning to `reopen`; forge-fix applies the listed Bugs.
- ABSTAIN → multi-vote harness could not run (`<reason>`); stays `developed` for a human.
```

## Verdict decision (mechanical)

- **APPROVE** — zero `Bug` findings (any number of `Minor`/`Low` is OK; flag them in the
  comment but do not block; file `Minor` findings via `forge_issues.createTask` before
  transitioning).
- **REQUEST CHANGES** — one or more `Bug` findings.
- **ABSTAIN** — review skill couldn't run (branch missing on remote, can't read diff,
  infrastructure failure mid-review). Use sparingly.

## Posting order

Comment FIRST (always), then transition status. The transition is the **last** action — it
triggers the next pipeline step, which will read the verdict comment.
