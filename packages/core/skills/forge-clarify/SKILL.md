---
name: forge-clarify
description: "Clarify and validate Forge issues before planning — reproduce bugs via browser, verify UX expectations for features, capture evidence screenshots. Use this skill after triage (confirmed status) to ensure the issue is well-understood before writing an implementation plan. Triggers on: /forge-clarify, clarifying issues, reproducing bugs, validating UX, verifying issue understanding. Also use when the pipeline needs to move an issue from confirmed to clarified status."
user_invocable: true
arguments: "documentId"
---

# Forge Clarify

This is the step between triage and plan: `confirmed → clarified`. Its job is to validate understanding — reproduce bugs in a live environment, verify UX expectations for features, and capture visual evidence. This prevents the plan step from targeting the wrong code path or misunderstanding the desired outcome.

**Every issue passes through clarify** — there is no auto-skip. Scale the depth to the issue: a trivial `xs`/`s` change needs only a quick intent restate + confidence check (no full reproduction), while a bug or larger feature gets the full investigation below.

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

> **Pull-model note:** On large issues `forge_step_start` returns a lean manifest (`bodyTruncated:true`). Fetch `description`/`acceptanceCriteria` as needed via `forge_issues.get { documentId, fields: ['description', 'acceptanceCriteria'] }` rather than assuming full body is present.

### Step 1: Fetch Issue & Triage Context

Fetch the issue and its comments in parallel:

```
forge_issues → get → { documentId: "<id>" }
forge_comments → list → { filters: { issue: "<documentId>" } }
```

Find the triage comment (starts with `**Triage**` by Snorlax) and extract **complexity** (`xs/s/m/l/xl`) and **category** — they set how deep to go (trivial → quick restate; bug/large → full investigation).

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

### Step 3c: Ground acceptance criteria in the UX contract (if the project has one)

If the project has a `ux-contract` projectFact (a per-project UX completeness standard, injected into your context) and this change is **user-facing**, ground the `acceptanceCriteria` in its *Definition of UX-Done*: every applicable required-state / a11y / microcopy / responsive item becomes a checkable AC (e.g. loading, empty, empty-search-if-searchable, error+retry, success/error feedback, destructive-confirm, keyboard+visible-focus, works at the contract's min width). Functional-only ACs let a working-but-incomplete screen pass every gate — the ACs are what review and QA verify. Append the missing items via `forge_issues → update { acceptanceCriteria }`. Projects without a `ux-contract`, and backend-only changes, are unaffected.

### Step 4: Post Comment & Set Status

(Release notes are NOT drafted here — they are written at the release step, where the change is fully implemented and the user-facing summary reflects what actually shipped rather than a pre-implementation guess.)

If you captured screenshots, attach them to the comment. For a small image, pass it inline via the comment's `attachments` (base64). For anything larger, use the **`forge_uploads`** presigned-URL flow (request an upload URL for target `comment`, `curl -T` the file to it, then reference the returned `url` in the comment body). There is no `forge_issues.upload` action — don't call one.

Post a clarify comment with findings:

```
forge_comments → create → {
  data: {
    body: "<clarify report>",
    issue: "<documentId>",
    author: "Jigglypuff",
    attachments: [<small inline base64 images, if any>]
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

Use the per-outcome templates (Bug reproduced / cannot-reproduce, Feature clear / ambiguous) in `references/comment-formats.md` — each carries the **Confidence** line and, for features, the restated **Intent**.

## Clarify-specific output reminder

Screenshots are evidence — capture and attach to the comment (inline base64, or via `forge_uploads` for larger files). Always write clarify comments in English regardless of issue language. (See pipeline preamble for general output rules.)
