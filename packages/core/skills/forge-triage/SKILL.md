---
name: forge-triage
description: "Triage and validate Forge project management issues before development begins. Use this skill whenever issues need to be reviewed for completeness, classified by complexity, or assigned category/priority. Triggers on: /forge-triage, triaging issues, validating issue quality, classifying issue complexity, setting issue priority, reviewing new issues, checking if issues are actionable. Also use when the pipeline needs to move an issue from open to confirmed status. Even if the user just says 'triage this' or 'check if this issue is ready', use this skill."
user_invocable: true
arguments: "documentId1 documentId2 ..."
---

# Forge Triage

Triage gates the pipeline — it catches incomplete issues before they waste expensive planning and coding cycles. An issue that bounces back with questions burns an entire plan-code-review round trip.

Do not read the codebase — triage should be fast and cheap; codebase exploration happens in `forge-plan`. But you CAN and SHOULD read project memory + issue history: interpreting what an issue is asking for is triage's job, and that context is cheap to pull via MCP tools.

## Usage

```
/forge-triage <documentId>
/forge-triage <documentId1> <documentId2>
```

## Tools

- **forge_issues** — get/update issues
- **forge_comments** — list/create comments
- **forge_memory_search** — recall prior issue outcomes, conventions, decisions before bouncing. You cannot read the codebase, but you CAN read project memory + issue history to interpret an ask.

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

**DEFAULT = CONFIRM. `needs_info` is the rare exception, never a safety reflex.** For enhancement / improvement / refactor / UI-polish / "make X consistent" issues, the reporter is NOT expected to pre-specify what/where/to-what-pixel — that discovery is the pipeline's job (triage interprets intent → clarify reproduces/captures → plan designs with codebase access). Bouncing such an issue for "missing detail" is itself a triage failure.

**Never ask, at triage, for clarify/plan DELIVERABLES:** screenshots/visual examples, a per-element diff list, pixel-exact/numeric ACs, which design is the source of truth, an impact/business justification, or specific file/component/endpoint names. If a draft bounce asks for any of these → delete it and CONFIRM with a one-line interpretation note.

**Only TWO things justify `needs_info`:** (1) a BUG missing ALL of steps-to-reproduce + observable symptom + conditions (genuinely reporter-held, no investigation starting point); (2) a TRUE product fork — two readings build materially different things and guessing wrong burns a real cycle; you MUST name option A vs option B. "Vague / could be done several ways" is NOT a fork when the variants converge on the same surface.

**Specific-question test** (run before any bounce): complete "I need [X] from the reporter because the answer decides [outcome A] vs [outcome B]." Can't name a concrete X and two diverging outcomes → you're pattern-matching on vagueness → CONFIRM.

**Look before you bounce — you are codebase-blind, not context-blind.** Before considering `needs_info`, spend one cheap pass on `forge_issues → list` (recent/related issues by the feature/area keywords) + `forge_memory_search`. A running chain on the same area or a memory entry usually already establishes intent, the canonical component/pattern, and scope — so the question answers itself.

If the issue is actionable → proceed to Step 3.

If, after the look-before-you-bounce pass, the issue is still incomplete under the two-only test above → set `needs_info` and stop:

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

Read `references/complexity-rules.md` for detailed rules. The `complexity` field is one of `xs / s / m / l / xl`:

- **xs** — trivial: typo, copy, constant, one-line config; no real logic.
- **s** — simple: single file/component, isolated change following an existing pattern.
- **m** — medium: 2–5 files in one package; may add a small util/hook/component.
- **l** — large: ~6+ files, a sizable feature, or cross-cutting within a package.
- **xl** — epic: cross-package + schema/API/UI together, a new subsystem, or a decompose candidate.

This assessment matters because `forge-plan` uses it to decide whether to auto-approve the plan (`xs/s/m`) or hold it for human review (`l/xl`), and whether the issue is a decompose candidate. Getting it wrong toward `l/xl` wastes time on unnecessary human gates; too low risks under-planning. When uncertain, lean toward `m` — `forge-plan` can upgrade after reading the actual codebase.

**No-code deliverables** (decision/audit/spike — issues whose only output is a write-up, no source change): these flow through the pipeline by materializing a `docs/proposals/<topic>.md` artifact (forge-plan handles the routing). Do **NOT** flag them for decomposition no matter how many recommendations they list — a pure decision has nothing to integrate. Note the no-code nature in the triage comment so forge-plan plans the docs artifact rather than a code change.

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
    complexity: "<xs|s|m|l|xl>",
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

**Complexity:** <xs/s/m/l/xl> — <brief justification>
**Category:** <category> <(inferred) if it was missing>
**Priority:** <priority> <(inferred) if it was none>
**Relations:** <list of linked issues with ISS-id and relation type, or "None detected">
```

Keep it concise — this comment is read by both humans and downstream pipeline skills.

**Always write triage comments in English**, regardless of what language the issue is written in. Downstream skills and pipeline automation parse these comments — they must be in English for consistency.

## Pitfalls

- **Over-bouncing is the #1 triage failure.** Re-read Step 2's ban list before any `needs_info`.
- **To deliberately park an issue, use `status: on_hold`** (an explicit pause) rather than pairing a pause with the `confirmed`-status transition. The legacy `manualHold` flag was removed (ISS-393): mechanically-failed jobs now revert to the stage entry-status and auto-retry, or park at `waiting` when the retry budget is exhausted — the system handles failure parking, so triage never needs a hold flag.
