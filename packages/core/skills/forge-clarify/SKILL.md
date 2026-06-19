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
- **Browser (optional)** — if a browser-automation MCP is available, use whatever browser tools the runner exposes (auto-detected; usually surfaced as `browser_*`: navigate, click, type, snapshot/screenshot). Do not hardcode a provider. If no browser MCP is available, fall back to curl/WebFetch HTML checks.
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
2. **Open the live URL** using the available browser tools
3. **Login** if test credentials are available (from project config)
4. **Follow the reported steps** exactly:
   - Screenshot each step for evidence
   - Record actual vs expected behavior at each point
5. **Assess:**
   - **Reproduced** → note exact error, console output, visual evidence
   - **Cannot reproduce** → note what was tried, what happened instead

### Step 3b: Feature/Improvement Investigation

If category is not `bug`:

1. **Navigate to the area being changed** in the live environment (browser, or the API/CLI surface for headless projects)
2. **Capture the current state** — screenshot the UI, or the current API response/schema — so the plan step has a baseline
3. **Compare** with any mockups/designs in issue attachments
4. **Identify existing UX/API patterns** in the same area (button styles, layouts, interactions; or contract shape, auth, error semantics) — the change should match these, and note the expected empty/loading/error states the feature will need
5. **Check for ambiguities** — does the issue description fully specify the desired outcome?

6. **Restate the intent** so plan/code don't re-derive it from a one-line title — capture: **Outcome** (what the user can do/see after) · **User/role** · **Why now** · **Success** (how we'd know — ties to acceptanceCriteria) · **Constraint** (must-respect limits) · **Out of scope**. Where the issue is silent on a dimension, state your best assumption so it surfaces for correction instead of being buried.

### Step 4: Draft Release Notes

Before posting the clarify comment, draft a user-facing release-notes blurb and persist it to the issue's typed `releaseNotes` field. forge-release reads this field at close time to append a bullet to `CHANGELOG.md` under `## [Unreleased]`. The `forge-cut-release` skill later promotes that section to a tagged version block.

**Pick the section.** Map the issue to the right [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) bucket:

| Section | When to pick |
|---|---|
| `Added` | A new feature, screen, command, endpoint, or capability the end user can perceive |
| `Changed` | Behavior the user already had changes in a visible way (UI, defaults, semantics) |
| `Fixed` | A bug the user could hit is now resolved |
| `Removed` | A capability went away |
| `Security` | A vulnerability is patched; phrase neutrally so it doesn't read like a CVE advisory |
| `Skip` | Internal-only change (refactor, infra, test harness) — no `CHANGELOG.md` entry needed |

**Draft the two strings.**

- **userFacing** — 1-2 plain sentences a non-developer can understand. Lead with the user-visible verb ("Added X", "Fixed Y", "You can now Z"). Avoid file names, function names, ticket IDs. Max 500 chars.
- **technical** *(optional)* — one terse line of breadcrumbs for maintainers (root-cause, the surface area). Max 500 chars.

**Persist via the typed field.** Write to `releaseNotes` with `forge_issues → update`:

```
forge_issues → update → {
  documentId: "<id>",
  data: {
    releaseNotes: {
      section: "Fixed",
      userFacing: "Avatar uploads no longer time out for files above 2 MB.",
      technical: "Multipart streaming in core/issues/attachment-service handled chunks under one fetch deadline."
    }
  }
}
```

For internal-only changes use `{ section: "Skip", userFacing: "-" }`. `userFacing` is required by the schema even for Skip — forge-release short-circuits on the section, not on the string.

This is the source of truth — do NOT also write a release-notes block into `description`. Description belongs to the developer; the typed field belongs to the user-facing summary.

### Step 5: Post Comment & Set Status

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

**Confidence gate — decide the exit by how sure you are, not by gut feel.** State a one-line hypothesis of what the issue wants plus a **confidence 0–100%** in the clarify comment. Calibrate it: *"Can I predict how the reporter would react to the next three questions I'd ask?"* If yes, confidence is high; if you'd be guessing, it isn't.

- **High confidence (≈85%+)** — bug reproduced, OR feature intent validated and the restate has no load-bearing gaps → `clarified`.
- **Below the bar** — cannot reproduce, OR an implementation-changing dimension is unresolved (which surface, which role, what "done" means, a binding constraint) → `needs_info`. Don't pass a coin-flip issue to plan; a wrong assumption here burns a whole plan→code→review round-trip.

When you set `needs_info`, ask **specific questions that each carry your best guess**, e.g. *"Should the export include archived items? My assumption: no, only active — confirm?"* — the reporter reacts to a concrete proposal (fast) and you commit to a testable prediction.

**Set status LAST** (triggers the plan step):

```
forge_issues → update → { documentId: "<id>", data: { status: "clarified" } }
```

## Comment Formats

Use the per-outcome templates (Bug reproduced / cannot-reproduce, Feature clear / ambiguous, Auto-skip) in `references/comment-formats.md` — each carries the **Confidence** line and, for features, the restated **Intent**.

## Clarify-specific output reminder

Screenshots are evidence — capture, upload, attach to comment. Always write clarify comments in English regardless of issue language. (See pipeline preamble for general output rules.)
