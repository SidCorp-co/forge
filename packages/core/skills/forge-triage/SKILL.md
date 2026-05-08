---
name: forge-triage
description: "Triage and validate Forge project management issues before development begins. Use this skill whenever issues need to be reviewed for completeness, classified by complexity, or assigned category/priority. Triggers on: /forge-triage, triaging issues, validating issue quality, classifying issue complexity, setting issue priority, reviewing new issues, checking if issues are actionable. Also use when the pipeline needs to move an issue from open to confirmed status. Even if the user just says 'triage this' or 'check if this issue is ready', use this skill."
user_invocable: true
arguments: "documentId1 documentId2 ..."
---

# Forge Triage

Triage gates the pipeline — it catches incomplete issues before they waste expensive planning and coding cycles. An issue that bounces back with questions burns an entire plan-code-review round trip.

Operate purely on issue data via MCP tools. Do not read the codebase — triage should be fast and cheap. Codebase exploration happens in `forge-plan`.

## Usage

```
/forge-triage <documentId>
/forge-triage <documentId1> <documentId2>
```

## Tools

- **forge_issues** — get/update issues
- **forge_comments** — list/create comments

## Workflow

### Step 1: Fetch Issue Data

Fetch the issue and its comments in parallel:

```
forge_issues → get → { documentId: "<id>" }
forge_comments → list → { filters: { issue: "<documentId>" } }
```

Review all available fields: title, description, acceptanceCriteria, aiAcceptanceCriteria, suggestedSolution, aiSuggestedSolution, plan, category, priority, status, comments.

For multiple issues, triage each independently — separate assessments, separate comments.

### Step 2: Evaluate Completeness

Read `references/triage-criteria.md` for the full criteria. The core question: **can a developer understand what to change and what the result should be?**

If the issue is actionable → proceed to Step 3.

If the issue is incomplete → set `needs_info` and stop:

```
forge_issues → update → { documentId: "<id>", data: { status: "needs_info" } }
forge_comments → create → { data: { body: "<specific questions>", issue: "<documentId>", author: "Snorlax" } }
```

Ask **specific questions** — vague "please add more detail" wastes time because the reporter doesn't know what's needed:
- "What is the expected behavior when X happens?"
- "Which page/endpoint is affected?"
- "Can you describe the steps to reproduce?"

After posting, **stop** — do not proceed further for this issue.

### Step 3: Classify Complexity

Read `references/complexity-rules.md` for detailed rules. Briefly:

- **Simple** — single file/component, isolated change
- **Medium** — 2-5 files, single package
- **Complex** — cross-package, schema changes, new APIs

This assessment matters because `forge-plan` uses it to decide whether to auto-approve the implementation plan or require human review. Getting it wrong in the "too complex" direction wastes time on unnecessary human gates; too simple risks under-planning. When uncertain, lean toward Medium — `forge-plan` can upgrade after reading the actual codebase.

### Step 4: Set Category

If category is missing or empty, infer from description language:

| Signal | Category |
|--------|----------|
| "broken", "error", "crash", "not working", "regression" | bug |
| "add", "new", "create", "implement", "support" | feature |
| "improve", "better", "optimize", "refactor", "enhance" | improvement |
| "update", "change", "migrate", "configure", "setup" | task |

If ambiguous, default to `task`. Only set category if it's missing — preserve the reporter's choice if one exists.

### Step 5: Set Priority

If priority is `none`, infer from context:

| Signal | Priority |
|--------|----------|
| Production down, data loss, security vulnerability | critical |
| Blocking users, major feature broken, deployment blocked | high |
| Non-blocking bug, moderate UX issue, requested feature | medium |
| Minor cosmetic, nice-to-have, low-traffic area | low |

Consider: severity of impact, number of users affected, urgency language. Only set priority if it's `none` — preserve the reporter's choice if one exists.

### Step 6: Detect Related Issues

Search for issues that might overlap with this one. Users often create related issues without linking them — catching this at triage prevents duplicate work and surfaces dependencies early.

Extract 2-3 key terms from the issue title/description (feature names, component names, error messages — not generic words like "fix" or "add"). Run a search for each:

```
forge_issues → list → { filters: { search: "<key term>" } }
```

From the results, look for issues that:
- Touch the **same feature, page, or component**
- Describe the **same bug from a different angle**
- Would **conflict or overlap** if worked on in parallel
- Are **duplicates** or near-duplicates

Skip issues that merely share a keyword but are about different things.

If related issues are found, include them in the update (Step 7) using the `relations` field:

```
relations: [
  { type: "related_to", targetDocumentId: "<docId>", reason: "Both affect the pipeline settings UI" },
  { type: "duplicate_of", targetDocumentId: "<docId>", reason: "Same bug reported differently" },
  { type: "blocked_by", targetDocumentId: "<docId>", reason: "Requires schema change from ISS-42" }
]
```

Use the appropriate relation type:
- **related_to** — same area/feature, good to be aware of
- **duplicate_of** — same issue described differently (set this issue to `needs_info` with a comment pointing to the original)
- **blocked_by** — can't start this until the other completes
- **depends_on** — needs output from the other issue
- **caused_by** — this issue is a consequence of the other

If no related issues are found, skip — don't force relations.

### Step 7: Save Classifications, Post Comment & Set Status

First, save classification fields (without status change):

```
forge_issues → update → {
  documentId: "<id>",
  data: {
    complexity: "<Simple|Medium|Complex>",
    category: "<inferred if was missing>",
    priority: "<inferred if was none>",
    relations: [<existing relations>, <new relations if any>]
  }
}
```

Post a triage summary comment:

```
forge_comments → create → {
  data: {
    body: "<triage summary>",
    issue: "<documentId>",
    author: "Snorlax"
  }
}
```

**Set status LAST** (triggers next pipeline step):

```
forge_issues → update → { documentId: "<id>", data: { status: "confirmed" } }
```

### Triage Comment Format

```markdown
**Triage** — <one-line summary of what the issue is about>

**Complexity:** <Simple/Medium/Complex> — <brief justification>
**Category:** <category> <(inferred) if it was missing>
**Priority:** <priority> <(inferred) if it was none>
**Relations:** <list of linked issues with ISS-id and relation type, or "None detected">
```

Keep it concise — this comment is read by both humans and downstream pipeline skills.

**Always write triage comments in English**, regardless of what language the issue is written in. Downstream skills and pipeline automation parse these comments — they must be in English for consistency.

## Pitfalls

- **Do not set `manualHold: true` at create time.** The dispatcher's L1 gate skips on `manual_hold`, leaving the plan job queued; the queued-watchdog formerly counted that against the 5-retry recovery budget and tipped the issue into `pipeline_failed` (ISS-66). The fix in core now skips `manual_hold`-gated jobs, but the safer idiom is still to either (a) leave `manualHold` false at creation and toggle it after the issue settles, or (b) use `status: on_hold` for an explicit, deliberate pause.
