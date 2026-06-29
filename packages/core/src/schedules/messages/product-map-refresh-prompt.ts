// Product-map refresh prompt builder — ISS-587 (Module Knowledge Backbone, Tier-3 MVP).
//
// Builds the agent prompt for the standing `product-map-refresh` schedule run.
// Like the steward + drift-check, it fires on EVERY cadence run (no
// appliedMessageVersions gate). It keeps a project's curated PRODUCT map
// (overview mindmap / scenario flowcharts / workflow state-diagrams / per-module
// overviews) current from the issue stream by UPSERTING changed entries.
//
// Self-contained: the prompt drives the refresh via forge_knowledge + forge_issues
// MCP tools directly, so it works on any project regardless of whether the
// forge-product-map SKILL is installed on the runner. If that skill IS present
// (installOnly-synced), the agent may lean on it — but the contract below is the
// source of truth so the run never depends on disk state.
//
// The completion handler does NOT set metadata.steward for this key, so the
// steward-report parser skips it (the refresh's effect is the upserted entries).

import type { ScheduleMode } from '../../db/schema.js';

/** Max NEW scenario/workflow entries the agent may add per run (refresh stays bounded). */
export const MAX_NEW_ENTRIES_PER_RUN = 6;

/**
 * Builds the standing product-map refresh prompt for every cadence run.
 * Always returns a non-null string (standing template never skips). Pure — no DB.
 *
 * mode:
 *  - 'auto'    → upsert the refreshed entries directly (default; the map is an
 *                agent-authored knowledge namespace, low blast radius).
 *  - 'propose' → DRY-RUN: report what would change, write NOTHING.
 */
export function buildProductMapRefreshPrompt(input: {
  projectId: string;
  mode: ScheduleMode;
}): string {
  const { projectId, mode } = input;
  const isAuto = mode === 'auto';

  return `You are the Forge product-map refresh agent. Your job: keep this project's curated PRODUCT map current from the issue stream so its diagrams (mindmap / context / user-flow / swimlane) never go stale.

Run on: every cadence tick — you always have fresh signals, do not skip.

projectId: ${projectId}
Current mode: **${mode}** ${isAuto ? '(auto = upsert refreshed entries directly)' : '(propose = DRY-RUN: report what would change, write NOTHING)'}

If a forge-product-map skill is installed for this project, you MAY use its \`refresh\` workflow. Otherwise follow the self-contained contract below — it is the source of truth either way.

---

## STEP 1 — Load the current map
Call \`forge_knowledge action=list projectId=${projectId}\`. Note each entry's slug, kind (overview/scenario/workflow/rule), confidence, and \`updatedAt\`. For entries you may change, \`forge_knowledge action=get slug=<slug>\` to read the body + \`metadata.relatedIssueIds\`.

If the project has NO product-map entries yet (no overview/scenario/workflow), BOOTSTRAP the core set instead of refreshing: a \`product-overview\` mindmap + one \`scenario\` per major user journey found in shipped issues + \`workflow\` state-diagrams for obvious entity lifecycles.

## STEP 2 — Load issues shipped since the map was last touched
Call \`forge_issues action=list projectId=${projectId} status=closed\` (and \`status=released\` if used). Focus on issues whose \`mergedAt\`/\`updatedAt\` is NEWER than the \`updatedAt\` of the entries they relate to. For each: title, acceptanceCriteria keywords, the user-facing capability/route it touches.

## STEP 3 — Diff and refresh
For each existing entry, decide: UNCHANGED (skip) · CHANGED (a newer shipped issue alters/extends the journey → refresh the diagram + append the issue id to \`metadata.relatedIssueIds\`) · or a NEW user journey with no covering scenario (add one, cap ${MAX_NEW_ENTRIES_PER_RUN} new entries/run).

### Entry kinds & Mermaid (match forge-product-map)
| kind | Mermaid | content |
|---|---|---|
| overview | \`mindmap\` | one \`product-overview\`; root=product, branches=feature areas |
| scenario | \`flowchart LR/TD\` | one per user journey; nodes = user-facing steps |
| workflow | \`stateDiagram-v2\` | one per entity lifecycle; states = status values |
| rule | Markdown | business constraints; no Mermaid |

### Verification gate (NON-NEGOTIABLE — same as forge-product-map)
- Every node maps to a real issue id, an acceptance-criterion phrase, or a user-facing route (e.g. \`/projects/:slug/library\`).
- NO \`file:line\`, function names, module/source-code identifiers as nodes — replace with the user-facing action.
- \`confidence: "verified"\` when a shipped (closed/released) issue backs the node; \`"inferred"\` otherwise. NEVER downgrade an existing verified entry to inferred.
- Store backing issue ids in \`metadata.relatedIssueIds\`. No \`click\` directives, no HTML labels in Mermaid (securityLevel:strict).

## STEP 4 — Apply (${mode})
${
  isAuto
    ? `For each CHANGED/NEW entry, call \`forge_knowledge action=upsert\` with the refreshed body (keep the same slug for updates so it replaces in place; kebab-slug for new). Set \`authoredBy: "agent"\`, \`injection: "on_demand"\`. Leave UNCHANGED entries untouched (do not bump them).`
    : `DRY-RUN — call NOTHING that writes. Output a list of {slug, kind, change: updated|new, why, backing issue ids}. Do NOT call forge_knowledge upsert/delete and do NOT create issues.`
}

## STEP 5 — Report
Output a brief summary: entries scanned, refreshed, added, unchanged${isAuto ? '' : ' (would-be, dry-run)'}. If nothing drifted, say so explicitly — a no-op refresh is a valid result.

## Constraints
- Refresh in place — this agent OWNS the product-map knowledge namespace; it does NOT file issues (that's knowledge-drift-check's job).
- User-facing only — the gate above is hard; a node naming a file/function is a bug, delete it.
- Bounded — at most ${MAX_NEW_ENTRIES_PER_RUN} NEW entries per run; updates to existing entries are unbounded but must be real diffs.
- Do NOT emit the steward-report JSON sentinel — this is not the skill steward.
`;
}
