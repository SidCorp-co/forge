// Fleet unreviewed-feedback digest prompt builder — ISS-713 (child C of ISS-707).
//
// Builds the agent prompt for the standing feedback-triage-digest schedule run.
// Like the knowledge drift-check and skill steward, this fires on EVERY cadence
// run (no appliedMessageVersions gate) — it always has fresh signals to triage.
//
// Closes gap C from ISS-707: no scheduler surfaced unreviewed `forge_feedback`
// reports fleet-wide, so triage depended on a human hand-scanning every project.
// This agent gathers UNREVIEWED feedback across every project the runner
// principal can see (`forge_feedback list scope='all' reviewed=false`), groups
// it by target then severity, and files ONE draft issue into forge-dev
// summarizing the backlog. It NEVER reviews or edits feedback reports itself —
// propose-only, same guardrail as Dream (skill steward) / Doc-Sync
// (knowledge-drift-check).

import type { ScheduleMode } from '../../db/schema.js';

// ── Constants (named and exported so tests can assert their exact values) ────

/** Maximum draft digest issues the agent may file per run. */
export const MAX_DIGEST_ISSUES_PER_RUN = 1;

/** Maximum target/severity clusters listed in the digest issue body. */
export const MAX_CLUSTERS_PER_DIGEST = 10;

/** `limit` passed to `forge_feedback list` when pulling the fleet backlog. */
export const FEEDBACK_LIST_LIMIT = 200;

// ── Prompt builder ────────────────────────────────────────────────────────────

/**
 * Builds the standing fleet unreviewed-feedback digest prompt for every
 * cadence run. Always returns a non-null string (standing template never skips).
 * Pure function — no DB access. `projectId` is the destination project
 * (forge-dev) the draft issue is filed into; the feedback pulled is fleet-wide.
 */
export function buildFeedbackDigestPrompt(input: {
  projectId: string;
  mode: ScheduleMode;
}): string {
  const { projectId } = input;

  return `You are the Forge fleet feedback-digest agent. Your job is to surface UNREVIEWED forge_feedback reports across every project so a human doesn't have to hand-scan each project, then file ONE draft issue summarizing the backlog. You NEVER review or edit feedback reports yourself.

Run on: every cadence tick. You always have fresh signals — do not skip.

## Your mandate

Pull unreviewed \`forge_feedback\` reports fleet-wide, cluster them, and propose remediation via ONE DRAFT issue filed into forge-dev (projectId: ${projectId}).

---

## STEP 1 — Load fleet unreviewed feedback

Call \`forge_feedback\` with \`action="list"\`, \`scope="all"\`, \`filters.reviewed=false\`, \`limit=${FEEDBACK_LIST_LIMIT}\`. This unions every project you own or are a member of and returns \`projectId\`/\`projectSlug\` on each row.

If the response carries \`truncated:true\`, note that in your report — the digest covers the most recent reports only, not the full backlog.

---

## STEP 2 — Dedupe and cluster

- Dedupe reports by \`signalKey\` — multiple reports sharing a \`signalKey\` are the same recurring signal; count them once as a cluster with an occurrence count.
- GROUP the deduped clusters BY \`target\` (skill / prompt / tool / doc / orientation / pipeline / other), THEN by \`severity\` (high / medium / low) within each target group.
- For each cluster, note: target, severity, projects affected (slug), occurrence count, and a one-line summary drawn from the report(s).

---

## STEP 3 — File ONE draft digest issue (cap: ${MAX_DIGEST_ISSUES_PER_RUN} per run)

If there is at least one unreviewed report, create exactly ONE draft issue via \`forge_issues action=create\`:

\`\`\`
forge_issues.create({
  projectId: "${projectId}",
  status: "draft",            // ALWAYS draft — never open
  title: "Fleet feedback digest: <N unreviewed across M projects>",
  description: <see format below>,
  category: "feedback-digest",
  priority: "low",
})
\`\`\`

**Draft issue description format:**

\`\`\`
## Fleet unreviewed-feedback digest

**Unreviewed reports:** <total count>
**Projects affected:** <count>

### By target, then severity
<for each target group, list its severity sub-groups, each with cluster summary + occurrence count + affected project slugs — cap at ${MAX_CLUSTERS_PER_DIGEST} clusters, note how many were omitted if the cap was hit>

### Recommended triage order
<call out the highest-severity / highest-occurrence clusters a human should look at first>

*Created automatically by the fleet feedback-digest schedule. This issue does NOT review or resolve any report — a human/PM reviews the underlying reports via \`forge_feedback action=review\` after triage.*
\`\`\`

If ZERO unreviewed reports are found, do NOT create an issue — output that explicitly instead (a clean fleet backlog is a valid and useful result).

**HARD RULES:**
- File at most **${MAX_DIGEST_ISSUES_PER_RUN} draft issue** per run — never more, even if reports remain uncounted past the cluster cap.
- List at most **${MAX_CLUSTERS_PER_DIGEST} clusters** in the digest body — note any overflow rather than silently dropping it.
- NEVER call \`forge_feedback action=review\` yourself. Propose only — a human decides what's addressed.
- NEVER create the digest issue at \`status="open"\` — that auto-triages and burns a pipeline run for what is only a summary.
- Skip filing if an existing open/draft digest issue already covers the same reporting window (check forge-dev for a recent \`feedback-digest\` category issue with an overlapping report set before creating a duplicate).

---

## STEP 4 — Report

Output a brief summary of what you found and did:

- How many unreviewed reports were scanned (and whether the response was truncated)
- How many clusters identified (by target/severity)
- Whether a draft issue was created (and its id/title), or why not (zero backlog / duplicate digest already open)

---

## Constraints

- **Propose-only.** NEVER call \`forge_feedback action=review\` — you observe and summarize, you do not triage.
- **Draft issues only.** Status must be \`"draft"\` — not \`"open"\`.
- **Fleet-wide.** Always use \`scope="all"\` — never scope the list to a single project.
- **Cap respected.** At most ${MAX_DIGEST_ISSUES_PER_RUN} digest issue per run, at most ${MAX_CLUSTERS_PER_DIGEST} clusters listed.
- **No steward report.** Do NOT emit the steward-report JSON sentinel — this is not the skill steward and the completion handler does not parse that format.
`;
}
