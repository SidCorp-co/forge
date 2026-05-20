---
name: forge-clarify
description: "Clarify and validate Forge issues before planning — reproduce bugs via browser, verify UX expectations for features, capture evidence screenshots. Use this skill after triage (confirmed status) to ensure the issue is well-understood before writing an implementation plan. Triggers on: /forge-clarify, clarifying issues, reproducing bugs, validating UX, verifying issue understanding. Also use when the pipeline needs to move an issue from confirmed to clarified status."
user_invocable: true
arguments: "documentId"
---

# Forge Clarify

This is the step between triage and plan: `confirmed → clarified`. Its job is to validate understanding — reproduce bugs in a live environment, verify UX expectations for features, and capture visual evidence. This prevents the plan step from targeting the wrong code path or misunderstanding the desired outcome.

Simple issues are auto-skipped (the lifecycle hook advances them to `clarified` without running this skill).

## Usage

```
/forge-clarify <documentId>
```

## Tools

- **forge_issues** — get/update issues
- **forge_comments** — list/create comments
- **Browser** — `mcp__claude-in-chrome__*` tools (navigate, click, type, screenshot) for live environment testing
- **WebFetch** — for API endpoint testing

## Workflow

### Step 1: Fetch Issue & Triage Context

Fetch the issue and its comments in parallel:

```
forge_issues → get → { documentId: "<id>" }
forge_comments → list → { filters: { issue: "<documentId>" } }
```

Find the triage comment (starts with `**Triage**` by Snorlax) and extract **complexity** and **category**.

Note: Simple issues are auto-skipped by the pipeline lifecycle — they never reach this skill. This skill only runs for Medium and Complex issues.

### Step 2: Resolve Live Environment

Determine where to test:

1. Issue's `previewUrl` / `previewApiUrl` (if a preview deployment exists)
2. Project's staging URLs from `forge_config → get` (previewDeploy.stagingUrl / stagingApiUrl)
3. If none available → skip browser testing, note in comment

### Step 3a: Bug Investigation

If category is `bug`:

1. **Read reproduction steps** from description, acceptanceCriteria, or attachments
2. **Open the live URL** in Chrome via browser tools
3. **Login** if test credentials are available (from project config)
4. **Follow the reported steps** exactly:
   - Screenshot each step for evidence
   - Record actual vs expected behavior at each point
5. **Assess:**
   - **Reproduced** → note exact error, console output, visual evidence
   - **Cannot reproduce** → note what was tried, what happened instead

### Step 3b: Feature/Improvement Investigation

If category is not `bug`:

1. **Navigate to the area being changed** in Chrome
2. **Screenshot the current state** of the UI
3. **Compare** with any mockups/designs in issue attachments
4. **Identify existing UX patterns** in the same area (button styles, layouts, interactions)
5. **Check for ambiguities** — does the issue description fully specify the desired outcome?

### Step 4: Post Comment & Set Status

Upload any captured screenshots:

```
forge_issues → upload → <file path>
```

Post a clarify comment with findings:

```
forge_comments → create → {
  data: {
    body: "<clarify report>",
    issue: "<documentId>",
    author: "Jigglypuff",
    attachments: [<media IDs if screenshots uploaded>]
  }
}
```

**Set status LAST** (triggers the plan step):

- If clear (bug reproduced, or UX validated) → `clarified`
- If ambiguous (cannot reproduce, or UX unclear) → `needs_info`

```
forge_issues → update → { documentId: "<id>", data: { status: "clarified" } }
```

## Comment Formats

### Bug — Reproduced

```markdown
**Clarify** — Reproduced: <one-line summary>

**Environment:** <URL tested>
**Reproduced:** Yes

**Steps Verified:**
1. <step> → ✅ <observation>
2. <step> → ❌ <error/unexpected behavior>

**Root Cause Hypothesis:** <what the code-level issue likely is>
**Evidence:** See attached screenshots
```

### Bug — Cannot Reproduce

```markdown
**Clarify** — Could not reproduce: <one-line summary>

**Environment:** <URL tested>
**Reproduced:** No

**Attempted:**
1. <step> → <what happened instead>

**Questions:**
- <specific question about environment/data/user role/timing>
```

→ Status: `needs_info`

### Feature — Clear

```markdown
**Clarify** — UX validated: <one-line summary>

**Current State:** <what exists now>
**Desired State:** <what should change, from issue description>
**Existing Patterns:** <similar UI patterns already in the app>
**Evidence:** See attached screenshots of current state
```

### Feature — Ambiguous

```markdown
**Clarify** — UX ambiguous: <one-line summary>

**Current State:** <what exists now>
**Ambiguities:**
- <specific question about desired behavior/appearance>
```

→ Status: `needs_info`

### Auto-Skip (Simple)

```markdown
**Clarify** — Auto-clarified (Simple issue, no UX verification needed)
```

## Clarify-specific output reminder

Screenshots are evidence — capture, upload, attach to comment. Always write clarify comments in English regardless of issue language. (See pipeline preamble for general output rules.)
