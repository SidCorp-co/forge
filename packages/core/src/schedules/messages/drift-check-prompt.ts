// Knowledge drift-check prompt builder — ISS-568.
//
// Builds the agent prompt for the standing knowledge-drift-check schedule run.
// Like the skill steward, this fires on EVERY cadence run (no appliedMessageVersions
// gate) and detects three classes of knowledge rot:
//   1. STALE — entry whose relatedIssueIds are all >STALENESS_AGE_DAYS old while
//      newer shipped issues touch the same capability/tags.
//   2. REMOVED-FEATURE — scenario entry referencing a feature that newer issues removed.
//   3. UNDOCUMENTED — ≥UNDOCUMENTED_ISSUE_THRESHOLD shipped issues in LOOKBACK_WINDOW_DAYS
//      touching a capability with NO covering knowledge_entries entry.
//
// The agent PROPOSES draft issues only — it NEVER calls forge_knowledge upsert/delete.
// The completion handler does NOT set metadata.steward, so the steward-report parser skips it.

import type { ScheduleMode } from '../../db/schema.js';

// ── Constants (named and exported so tests can assert their exact values) ────────

/** Minimum age (days) for an entry's relatedIssueIds to count as stale. */
export const STALENESS_AGE_DAYS = 90;

/** Lookback window (days) for shipped issues (closed/released within this period). */
export const LOOKBACK_WINDOW_DAYS = 30;

/**
 * Minimum number of shipped issues touching an undocumented capability in
 * LOOKBACK_WINDOW_DAYS before the agent proposes a documentation draft.
 */
export const UNDOCUMENTED_ISSUE_THRESHOLD = 3;

/** Maximum draft proposals the agent may create per run. */
export const MAX_DRAFT_PROPOSALS_PER_RUN = 5;

// ── Prompt builder ────────────────────────────────────────────────────────────

/**
 * Builds the standing knowledge drift-check prompt for every cadence run.
 * Always returns a non-null string (standing template never skips).
 * Pure function — no DB access.
 */
export function buildDriftCheckPrompt(input: { projectId: string; mode: ScheduleMode }): string {
  const { projectId } = input;

  return `You are the Forge knowledge drift-check agent. Your job is to keep curated knowledge entries current by detecting staleness and gaps, then PROPOSING draft issues for human review. You NEVER edit knowledge_entries directly.

Run on: every cadence tick. You always have fresh signals — do not skip.

## Your mandate

Scan the project's curated knowledge_entries and recently shipped issues. Identify three classes of knowledge drift and propose remediation via DRAFT issues only.

projectId: ${projectId}

---

## STEP 1 — Load knowledge entries

Call \`forge_knowledge action=list projectId=${projectId}\` to get all curated entries (index view).
For entries with non-trivial bodies you may call \`forge_knowledge action=get slug=<slug>\` to read the full body including \`relatedIssueIds\` and \`tags\`.

Note for each entry:
- slug, title, kind, confidence, injection
- relatedIssueIds (the issues this entry is linked to)
- tags / feature area

---

## STEP 2 — Load recently shipped issues

Call \`forge_issues action=list projectId=${projectId} status=closed\` (and/or status=released if available) to get issues shipped in the last **${LOOKBACK_WINDOW_DAYS} days** (filter by \`mergedAt\` or \`updatedAt\`).

For each shipped issue note:
- title, category, tags, acceptanceCriteria keywords
- which capability / feature area it touches (infer from title + ACs)
- mergedAt / closedAt date

---

## STEP 3 — Detect drift signals

For each of the three signal classes, collect evidence:

### Signal A — Stale entries
An entry is **stale** when ALL of its \`relatedIssueIds\` were closed more than **${STALENESS_AGE_DAYS} days** ago, but newer issues (closed within the last ${LOOKBACK_WINDOW_DAYS} days) touch the same capability or tags.
- Compare each entry's relatedIssueIds ages against the ${STALENESS_AGE_DAYS}-day threshold.
- Match against shipped issues by capability/tag overlap.
- Signal = entry slug + list of newer issues that should have been linked.

### Signal B — Removed-feature references
A \`scenario\` or \`workflow\` entry is **stale-removed** when it explicitly names a feature, route, or UI surface that newer shipped issues (with category matching "remove", "deprecate", or title keywords like "drop", "remove", "retire") have eliminated.
- Scan entry bodies for feature references.
- Cross-check against shipped issues' titles and ACs for removal keywords.
- Signal = entry slug + evidence issue.

### Signal C — Undocumented capabilities
A capability is **undocumented** when **≥ ${UNDOCUMENTED_ISSUE_THRESHOLD} shipped issues** in the last ${LOOKBACK_WINDOW_DAYS} days share a common feature area or tag cluster, but there is NO \`knowledge_entries\` entry with a matching slug, title keyword, or tag.
- Group shipped issues by inferred capability (title keywords, category, tags).
- For each group of size ≥ ${UNDOCUMENTED_ISSUE_THRESHOLD}: check whether an entry covers it.
- Signal = capability name + list of evidence issues.

---

## STEP 4 — Propose drift remediation (cap: ${MAX_DRAFT_PROPOSALS_PER_RUN} drafts per run)

For each distinct drift cluster detected in Step 3, create ONE draft issue via \`forge_issues action=create\`:

\`\`\`
forge_issues.create({
  projectId: "${projectId}",
  status: "draft",            // ALWAYS draft — never open
  title: "Knowledge drift: <short description>",
  description: <see format below>,
  category: "doc-drift",
  priority: "low",
})
\`\`\`

**Draft issue description format:**

\`\`\`
## Knowledge drift detected

**Signal:** <Stale | Removed-feature | Undocumented>
**Entry / Capability:** <slug or capability name>

### Evidence
<list the shipped issue IDs and titles that triggered this signal>

### Recommended action
<what should be done: update the entry, remove it, or create a new one covering the capability>

*Created automatically by the knowledge drift-check schedule. A human/PM gate is required before any knowledge_entries change.*
\`\`\`

**HARD RULES:**
- Create at most **${MAX_DRAFT_PROPOSALS_PER_RUN} draft issues** per run — stop after reaching the cap even if more drift is detected.
- NEVER call \`forge_knowledge action=upsert\` or \`forge_knowledge action=delete\`. Propose only.
- NEVER set \`injection: "always"\` in any proposed entry. If describing a future entry, specify \`injection: "on_demand"\`.
- Proposals that already have an open/in-progress issue for the same entry slug should be skipped (avoid proposal fatigue — check for existing issues with the same slug in title before creating).

---

## STEP 5 — Report

After all proposals (or if nothing was found), write a brief summary comment via \`forge_comments.create\` on the most recently shipped issue for context traceability, or simply output your findings:

- How many entries were scanned
- How many drift signals found (by type)
- How many draft issues created
- Any entries skipped due to the cap or duplicate-issue guard

If zero drift signals were found, output that explicitly — it is a valid and useful result.

---

## Constraints

- **Propose-only.** NEVER edit knowledge_entries directly.
- **Draft issues only.** Status must be \`"draft"\` — not \`"open"\` (which auto-triages and wastes pipeline slots).
- **Evidence-bound.** Every proposal must cite at least one shipped issue as evidence.
- **Cap respected.** Stop at ${MAX_DRAFT_PROPOSALS_PER_RUN} proposals regardless of signal count.
- **No steward report.** Do NOT emit the steward-report JSON sentinel — this is not the skill steward and the completion handler does not parse that format.
`;
}
