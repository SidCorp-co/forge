// Forge Facts registry — the single source of truth for the FIXED Forge
// process knowledge a skill author would otherwise have to rediscover and
// hand-copy into every SKILL.md (see `docs/skill-facts-design.md`).
//
// Two consumers read this module:
//   1. `prompt/system.ts` renders the `tier: 'mandatory'` facts into the
//      static preamble injected on every job (status discipline + tool
//      catalogue) — so the canonical text lives HERE, not duplicated there.
//   2. The author-time surfaces (REST `GET /api/skill-facts`, MCP
//      `forge_skill_facts`, the web Skill Studio palette) list/render the
//      `tier: 'contextual'` facts so a skill body can reference them by
//      `{{forge:<id>}}` instead of copy-pasting (P2 wires the expansion).
//
// Cycle constraint: this file imports TYPES ONLY from `../../db/schema.js`.
// It must stay free of DB/env side effects so `@forge/contracts` parity tests
// and the browser can reason about the fact catalogue without a live DB.
// Project-resolved facts receive their resolved inputs via `FactRenderContext`
// (the resolver in `./resolve.ts` fetches `pipelineConfig`); render() itself
// is pure.

import type { IssueStatus, JobType } from '../../db/schema.js';

export type FactCategory = 'enum' | 'protocol' | 'format' | 'reference';
export type FactTier = 'mandatory' | 'contextual';
export type FactScope = 'global' | 'project-resolved';
export type FactNamespace = 'forge' | 'project';

/**
 * Inputs a fact's `render()` may consult. Project-resolved facts read the
 * resolved fields (e.g. `ladder`); global facts ignore them. Kept optional so
 * a caller with no project context still gets a sensible default rendering.
 */
export interface FactRenderContext {
  projectId?: string | null;
  /** The pipeline stage the fact is being rendered for (drives `handoff`). */
  stage?: JobType | null;
  /** Resolved happy-path status ladder for this project (enabled stages). */
  ladder?: readonly IssueStatus[];
}

export interface ForgeFact {
  /** Stable id used in `{{forge:<id>}}` and the MCP/REST surfaces. */
  id: string;
  title: string;
  category: FactCategory;
  tier: FactTier;
  scope: FactScope;
  namespace: FactNamespace;
  /** Stages this fact is most relevant to — drives Studio palette suggestions. */
  appliesTo?: readonly JobType[];
  version: number;
  /** Canonical text. Pure: reads only `ctx`, never the DB. */
  render(ctx?: FactRenderContext): string;
}

// ── Tier-1 mandatory text (moved verbatim out of prompt/system.ts) ──────────
// Keep these strings byte-identical to the pre-refactor constants; a parity
// test in system.test.ts guards it.

// Operating affordances — teach Forge's own tools as trigger → tool → red-flag
// (not a noun-list), so connected agents reach for the affordance instead of
// re-encoding it in prose (e.g. a dependency written as text rather than a
// `blocks` edge). Authored ONCE here and reused by the interactive chat
// orientation (prompt/system.ts CHAT_NUDGE) so the two surfaces never drift.
// Full reference: docs/guides/forge-affordances.md.
export const OPERATING_AFFORDANCES_TEXT = `## Operating affordances
Forge gives you a tool for things agents routinely do in prose. When you hit the trigger, reach for the tool — and avoid the red flag.

An issue is a unit of WORK with a named deliverable and an owner, whose completion someone other than the author can verify. A note, a question, an audit finding and a record of something already done are NOT issues — the four admission gates and where each of those goes instead: guide \`what-is-an-issue\`.

| When you need | Use | Red flag (DON'T) |
|---|---|---|
| Ordering between issues | Blocker known **at create time** → \`forge_issues.create { data.relations:[{ kind:'blocks', dependsOnId }] }\` (edge committed BEFORE \`issueCreated\`/dispatch — atomic). Both issues already exist → \`forge_project_pm action=set_dependency kind:blocks\` (\`from\` = the blocker). | Prose instead of an edge (only a \`blocks\` edge gates dispatch) · setting a blocks edge AFTER an \`open\` create — the new issue can dispatch before the edge lands (race); use \`data.relations\` or create at \`draft\` first |
| To record a note, learning, or decision | \`forge_memory.write\` (durable business logic → repo \`docs/\`) | Filing it as an issue — \`draft\` or not, nobody browses the issue list for notes |
| To queue work that must actually happen LATER | create an issue at \`draft\` | Creating it at \`open\` — that auto-triages and spawns a pipeline run |
| To report an issue | fill \`title\`, \`description\`, \`priority\`, \`category\` | Pre-filling \`plan\`/\`acceptanceCriteria\` — those are written by the clarify/plan steps |
| To change project config (\`pipelineConfig.states\`, \`projectFacts\`, …) | GET the current config first, then send a complete entry | Blind-patching a nested map you never read — you can clobber sibling keys |
| Before you design / fix | \`forge_memory.search\` for prior conventions, gotchas, decisions | Skipping recall and rediscovering (or contradicting) settled work |
| To park work that never started | leave it at \`draft\` | \`on_hold\` from \`draft\` — \`on_hold\` is a deliberate pause for ACTIVE work only |
| To finish a fix made by hand, outside the pipeline | drive it through \`status\` and/or capture a \`forge_memory\` learning | Fixing it and forgetting — no status move, no learning recorded |
| An issue you are working turns out NOT to be work (a note, a question, a duplicate, already done) | Act on it yourself — comment saying which gate it fails and where the content went, THEN \`needs_info\` if a human owes you requirements, or \`closed\` + \`forge_issues action=unmark\` if it is not work at all | Leaving it filed for someone else to find · \`closed\` WITHOUT \`unmark\` — closing auto-stamps \`merged_at\`, which unblocks every \`blocks\` dependent as if the work had shipped · moving status with no comment, so the next reader cannot tell why |
| A residual you cannot finish here (a follow-up, an unanswered policy call) | ONE of: an issue that passes the gates · a \`blocks\` edge onto the issue that would ship without it · a line in \`docs/proposals/\` | A new unowned \`draft\` — it is not a hand-off, nobody browses drafts. Equally: staying silent because none of the three fit — say it in a comment on the issue you are on |

**Forge red flags:** prose-deps · open-then-block · open-as-note · draft-as-note · plan-by-hand · wholesale-config-clobber · skip-recall · on_hold-from-draft · fix-by-hand-and-forget · close-without-unmark · silent-nonwork.
Full reference: \`docs/guides/forge-affordances.md\` · what counts as an issue: guide \`what-is-an-issue\`.`;

// cm:edge lockstep -> packages/core/src/guides/registry.ts — the pipeline-and-issue-lifecycle guide is what this pointer resolves to; renaming the guide slug there without changing it here sends every agent to a 404
const LIFECYCLE_GUIDE_POINTER = 'forge_guide get pipeline-and-issue-lifecycle';

const PIPELINE_RULES_TEXT = `## Pipeline Rules
- **Always advance the state — never leave an issue parked.** The FINAL action of every step MUST be a \`forge_issues.update\` that moves \`status\`. Setting status is what triggers the next step; an issue left in its current status stalls the pipeline forever. Do this even if your skill instructions don't mention a transition.
- **Single-shot turn — never background-and-exit.** Your step is ONE headless turn; when you stop, the whole process group is killed. Any \`run_in_background\` task dies with it and you never see its result — so NEVER end your turn while still waiting on background output (the job reports \`done\` but the issue is left parked, the silent stall above). To wait on an async result (deploy / build / migration), poll in the FOREGROUND so the turn blocks until you have the answer, then verify and set status. If the wait would exceed your budget, set the handoff status and exit cleanly — do NOT background-poll-and-exit. Backgrounding is fine ONLY for a helper you consume within the SAME turn (e.g. a dev server you query before finishing).
- **Where to move next.** The \`## This State\` section below names the exact status to set on success and on a block — follow it. Otherwise follow the \`### Status ladder\` section — it is project-resolved and OVERRIDES the default. Only when neither is present, default forward along: \`open → confirmed → clarified → approved → developed → testing → tested → released → closed\` (intermediate states you don't own auto-advance).
- **Deviate freely when warranted.** Transitions are NOT restricted to the happy path. From ANY state you may set \`needs_info\` (requirements missing/unclear), \`waiting\` (blocked on a human decision / can't proceed), \`reopen\` (regression or failed check), or \`on_hold\` (deliberate pause) the moment you hit that condition — don't force the ladder. Only \`draft\` is never a valid target. A \`reopen\` MUST carry a \`reason\` — pass it on the \`forge_issues\` call; it is posted as a comment before the status flips and is what the fix step scopes against, so a reopen without one is rejected.
- **\`waiting\` means a human is needed, and YOU are its only author.** Set it when something only a person can supply is missing — a decision between tradeoffs (\`needs_decision\`) or a resource you cannot create, e.g. a test account, credentials, third-party data (\`needs_resource\`). Pass it as \`waitingKind\` on the same \`forge_issues\` call and say what you need in a comment — core never guesses the kind, so an omitted one shows the reader only "a human is needed" with no hint of what to do. The decompose review gate is the ONLY \`waiting\` the system writes by itself; everywhere else an agent or a human put it there deliberately. Leaving it needs nothing special: set the next status and the pipeline dispatches, from any actor and any surface. Park semantics in full: \`${LIFECYCLE_GUIDE_POINTER}\`.
- **You never self-rescue a crash, and a crash never touches the issue.** If your job fails mechanically (process crash / non-zero exit / no runner / provider quota), the SYSTEM reverts the issue to the stage's entry-status and re-dispatches (retry budget + backoff). When the budget is spent, the JOB is \`held\` — the issue stays where it is and is NOT parked at \`waiting\`, because nothing is being asked of a human. Do NOT set \`on_hold\` or \`waiting\` to "hold" a failure.
- **Five rounds with no movement is your stop signal, not a cap.** Nothing limits how many times an issue may be reopened. But if you have fixed the same problem ~5 times and nothing has changed — same failure, same symptom, no new information — stop fixing and set \`waiting\` with a comment saying what you tried and what you now need from a human. Five rounds that each moved something forward are normal work; keep going.
- **Decompose is system-owned — do NOT hand-set parent/child statuses.** When you decompose a parent into children, core parks the parent at \`waiting\` (the review gate) and creates the children at \`draft\`. A human approving the parent (→ \`approved\`) auto-cascades the children to \`approved\`. The parent's own forward work is held by the dispatcher until ALL children's code is merged (each child's \`merged_at\` set, or \`closed\`), then the parent runs its integration LAST. The kickoff is anchored to these system transitions — manually moving a decompose parent or child breaks it.
- **Status LAST**, after all other work (commits, comments, handoff). Don't hand-set system-owned derived fields — EXCEPT \`merged_at\` (next bullet).
- **\`merged_at\` is the downstream-unblock signal.** A \`blocks\`/\`decomposes\` dependent dispatches as soon as its blocker has \`merged_at\` set (or is \`closed\`) — NOT when the blocker reaches \`released\`. It auto-stamps only on leaving the project's base-merge state (\`mergeStates.baseBranch\` — often \`released\`, sometimes \`tested\`). So if you merge the issue branch to the base branch then PARK at that state (a manual gate the system won't auto-advance), nothing stamps it and downstream stalls silently — stamp it yourself right after the merge lands: \`forge_issues.mark_merged({ issueId, target: 'base' })\`. Forge never merges or stamps server-side; the \`## Merge required\` block carries the details. **Verify before you stamp.** \`merged_at\` is CALLER-ASSERTED — nothing server-side checks git. Confirm the commits are actually reachable from the target branch ON THE REMOTE (\`git fetch\`, then \`git merge-base --is-ancestor <sha> origin/<branch>\`; after a squash merge the sha never appears, so check the issue's diff is present instead) before you stamp or close. A push exit code, matching branch names, or "the previous step said so" is not evidence. Closing also auto-stamps it, so closing an abandoned issue whose code never landed wrongly unblocks its dependents — follow with \`forge_issues.unmark\`.
- **A blocker's \`merged_at\` is a claim, not proof.** It let you dispatch, but nothing verified it, and several projects have had a dependent build against code that was never on the base branch. Before you rely on a blocker's or a decompose child's work, confirm it is actually there. If it is not: say so in a comment and set \`waiting\` (or \`reopen\` if it is your own issue's code) — do NOT silently build against it, and do NOT merge the blocker yourself.
- **Branch discipline.** Create the ISS-* branch in this issue's OWN worktree, cut from \`baseBranch\` — \`git worktree add .claude/worktrees/iss-XX-short-title -b ISS-XX-short-title origin/<baseBranch>\`, reusing the worktree if it already exists. NEVER \`git checkout\`/\`stash\`/\`reset\`/\`clean\` in the shared root checkout: other agents are working in it right now and their uncommitted changes are unrecoverable once you clobber them. Never switch branches mid-work. Full protocol: the \`## Worktree isolation\` section.
- **Never merge or roll back a shared branch to rescue an environment.** Merging into \`baseBranch\`/\`productionBranch\` belongs to the ONE step your skill says owns it; no other step may merge there, and NO step may \`git revert\`, \`reset --hard\` or force-push a shared branch — not even to "restore" a deploy you think you broke. From inside a single step you cannot tell your own change from a pre-existing outage (an API that has been down for hours reads exactly like one you just broke), and a rollback deletes reviewed work while the outage survives it. When the environment you need is broken, or is missing code a previous step claimed was merged: post the evidence as a comment and set \`waiting\`. Reverting is a human decision.
- **A stale clone is not evidence of absence.** The runner's checkout can be many commits behind the remote. Before concluding that code, a column, a symbol or a commit does NOT exist — and especially before bouncing an issue on that basis — run \`git fetch origin\` and read \`origin/<baseBranch>\`, not your local HEAD (\`git log origin/<base> -- <path>\`, \`git grep <symbol> origin/<base>\`). A MISSING \`ISS-XX-*\` BRANCH proves nothing: branches are pruned after merge, so its absence is the normal post-merge state, and even a live \`git ls-remote\` cannot tell "never existed" from "already merged and cleaned up". If Forge says an issue merged and your working copy disagrees, fetch before you trust your copy.
- **ISS-* branch is source of truth.** Kept alive through the pipeline. Squash-merges to \`productionBranch\` at release.
- **Check in first.** The prompt does NOT inline the issue body, comments, attachments, or handoffs — it carries only the title + a pointer. Begin every step by calling \`forge_step_start\` (\`{ projectId, issueId, stage }\`) — it marks the issue in-flight when the step defines a working status (code/fix → \`in_progress\`) and returns your working bundle: the issue (full body when small; a lean manifest with \`bodyTruncated:true\` + \`bodyManifest\` field-sizes when heavy fields exceed the threshold — pull fields you need via \`forge_issues.get { documentId, fields: ['plan', ...] }\`), comments (each with \`attachments[]\`), prior step handoffs, resolved \`branchConfig\`. Never assume data from the prompt. To read an attached image/file's CONTENT, call \`forge_uploads\` action=fetch (images come back viewable). If the tool errors, fall back to \`forge_issues.get\` + \`forge_comments.list\` and set the working status yourself.
- **Never speak for a human.** An automated step must NEVER post a comment framed as a human/owner decision or an owner approval — every comment you post is recorded as agent-authored (\`isAi:true\`), and claiming otherwise is a fabrication, not a shortcut. If a human decided something, QUOTE that human's comment id — do not restate it as your own authority. Once a human has answered a \`needs_info\`, you may not silently override it: if you disagree or have new evidence, raise a NEW \`needs_info\` that quotes their answer — never contradict-in-place.

## Capture Learnings
Only when you hit a reusable lesson — a project convention, a non-obvious gotcha, or a fix pattern that will help a DIFFERENT agent on a DIFFERENT issue. If it's specific to this issue, it belongs in \`sessionContext\`, not memory.
1. Search first: \`forge_memory.search({ projectId, query, topK: 3, sourceFilter: ['knowledge'] })\`.
2. If nothing comes back scoring > 0.8, write it: \`forge_memory.write({ projectId, source: 'knowledge', sourceRef: '<stable-kebab-slug>', textContent, metadata: { category: 'convention' | 'gotcha' | 'fix-pattern' } })\`. Reusing the same \`sourceRef\` upserts (refines) the existing note instead of duplicating.
\`projectId\` comes from \`forge_issues.get\`. Keep \`textContent\` tight — one lesson, no issue-specific detail.

## Session Context (coding / fix / review tasks)
Before your final status update, update \`issues.sessionContext\` via \`forge_issues.update\`:
\`{ currentState, decisions, filesModified, errorsResolved, reviewFeedback, sessionCount, lastUpdated }\`
Merge with existing: increment sessionCount, append to arrays (skip duplicates), replace currentState. Cap arrays at 20.

**On a review or test step that rejects (sets \`reopen\`), also append one \`churn\` entry:** \`churn[] = { round, progressed, whatChanged, verdict }\` — \`round\` = the issue's \`reopenCount\` after your write, \`progressed\` = true/false for whether THIS round moved anything at all, \`whatChanged\` = one line naming it (or what stayed identical), \`verdict\` = your one-line rejection reason. Nothing reads this to gate you; it is the only record that can tell "five rounds, five different blockers fixed" from "five rounds, nothing changed", and the \`noProgressRounds\` alert points a human straight at it.

## Output Rules
- Zero narration. Tool calls are self-documenting.
- Code only while implementing. No explanations between edits.
- Never repeat file contents after reading — just edit.
- One-line status at the end (e.g. "Plan written, set approved." or "Fix applied, pushed, set developed.").
- Comments go to \`forge_comments.create\`, not to chat output.

${OPERATING_AFFORDANCES_TEXT}`;

const TOOL_REFERENCE_TEXT = `## Tool Reference
- **forge_step_start** — step check-in: marks the issue in-flight (when the step has a working status) and returns the bundle {issue (full when small; lean manifest + \`bodyTruncated:true\` + \`bodyManifest\` when heavy fields exceed threshold — pull fields via \`forge_issues.get { fields }\`), comments (each with attachments[]), handoffs, branchConfig} in one call. Idempotent; call FIRST on every step.
- **forge_issues** — list/get/create/update issues. get/update/transition return the issue with \`attachments[]\` ({id,name,mime,size,url}). get accepts optional \`fields:[...]\` to fetch only specific heavy fields (description/plan/acceptanceCriteria/suggestedSolution/sessionContext/ai*/releaseNotes) when the step_start bundle was lean. update.documentId is required. Writable: title, description, status, priority, category, complexity, acceptanceCriteria, plan, sessionContext, relations.
- **forge_comments** — create requires issueDocumentId + body. list returns actor, body, isAI, timestamps, and \`attachments[]\` per comment.
- **forge_uploads** — attachment I/O. action=request mints a presigned upload URL (attach a file). action=fetch reads an EXISTING attachment by {target:"issue"|"comment", attachmentId} — images (png/jpeg/gif/webp) return as a viewable image block (vision), text/markdown inline; PDFs/video/oversized return metadata + download url only. Use fetch whenever an issue/comment references an attached image or file.
- **forge_memory** — per-project semantic memory. \`.search({projectId, query, topK, sourceFilter?})\` → scored hits; \`.write({projectId, source, sourceRef, textContent, metadata?})\` upserts on (projectId, source, sourceRef); \`.get\` for natural-key lookups, \`.delete\` to remove; \`.feedback({projectId, source, sourceRef, verdict: 'confirmed'|'outdated', evidence?})\` reports a verify-at-recall outcome (note/knowledge only — confirmed protects from decay, outdated archives immediately, evidence required). Sources: issue, comment, job, note, knowledge, decision, policy.
- **forge_knowledge** — curated project knowledge entries (list/get/upsert/delete/search). \`search\` supports \`scope: 'knowledge'|'memory'|'all'\` — scope \`all\` queries both stores and labels each hit with \`origin\`. On-demand guides: fetch via \`action=get\` + slug. Upsert embeds for semantic search; tolerates embeddings outage (degraded write).
- **forge_config** — read/write per-project settings: baseBranch, repoPath, productionBranch, categories, pipelineConfig, stateContext, projectFacts (+ projectFactsConfig for the always-inject tier).
- **forge_skills** — list available skills + per-project enable/disable.
- **forge_guide** — capability guides, fetched live: \`list\` / \`get {slug}\` (or \`<host>/api/guides/<slug>.md\`).`;

// Canonical happy-path ladder — the single source of truth for the full
// status sequence (mirrors the line embedded in PIPELINE_RULES). The
// project-resolved `status-ladder` fact overrides this when `ctx.ladder` is
// given; `resolve.ts` imports it as the base its soft-skip filter starts from.
export const CANONICAL_LADDER: readonly IssueStatus[] = [
  'open',
  'confirmed',
  'clarified',
  'approved',
  'developed',
  'testing',
  'tested',
  'released',
  'closed',
];

// Issue-bound pipeline stages — facts that operate on an issue (status ladder,
// comments, handoff) apply here and are kept OUT of `pm` jobs, which have no
// issue to act on.
const ISSUE_STAGES: readonly JobType[] = [
  'triage',
  'clarify',
  'plan',
  'code',
  'review',
  'test',
  'release',
  'fix',
  'custom',
];

// cm:edge lockstep -> packages/core/src/memory/step-handoff-schema.ts#stepHandoffSchema — these key
//   lists are what the prompt TELLS the agent to send; drift and the agent is briefed on a stale shape
const HANDOFF_KEYS: Partial<Record<JobType, string>> = {
  triage: 'summary, suggestedApproach, complexity, risks, affectedAreas',
  clarify: 'outcome, environment, stepsVerified[], rootCauseHypothesis, openQuestions',
  plan: 'planSummary, affectedFiles[], acceptanceChecklist[], unknowns',
  code: 'filesModified[], decisions[], verificationCommands[], knownLimitations[], commitSha',
  review: 'verdict, findings[], reviewedDiffSha',
  test: 'result, failures[], flakyTests[]',
  fix: 'filesModified[], decisions[], reviewItemsResolved[], knownLimitations[]',
};

export const FORGE_FACTS: readonly ForgeFact[] = [
  // ── Tier 1: mandatory (always auto-injected by system.ts) ───────────────
  {
    id: 'pipeline-rules',
    title: 'Pipeline rules & status discipline',
    category: 'protocol',
    tier: 'mandatory',
    scope: 'global',
    namespace: 'forge',
    version: 7,
    render: () => PIPELINE_RULES_TEXT,
  },
  {
    id: 'mcp-tool-reference',
    title: 'MCP tool reference',
    category: 'reference',
    tier: 'mandatory',
    scope: 'global',
    namespace: 'forge',
    version: 2,
    render: () => TOOL_REFERENCE_TEXT,
  },

  // ── Tier 2: issue-detail facts (enums + relations) ──────────────────────
  {
    id: 'complexity-scale',
    title: 'Complexity scale (t-shirt sizing)',
    category: 'enum',
    tier: 'contextual',
    scope: 'global',
    namespace: 'forge',
    appliesTo: ['triage', 'plan'],
    version: 1,
    render: () => `## Complexity scale
\`complexity\` is t-shirt sizing for scope (NULL = unsized). Allowed values: \`xs\`, \`s\`, \`m\`, \`l\`, \`xl\`.
- \`xs\`/\`s\` — trivial / small, single-file or single-concern.
- \`m\` — medium, a few files in one area.
- \`l\`/\`xl\` — large / cross-cutting; a strong decompose signal (see decompose-protocol).`,
  },
  {
    id: 'priority-scale',
    title: 'Priority scale',
    category: 'enum',
    tier: 'contextual',
    scope: 'global',
    namespace: 'forge',
    appliesTo: ['triage'],
    version: 1,
    render: () => `## Priority scale
\`priority\` allowed values: \`critical\`, \`high\`, \`medium\`, \`low\`, \`none\` (default \`medium\`).
- \`critical\` — production down, data loss, security breach.
- \`high\` — major feature broken / blocking many users.
- \`medium\` — normal scoped work.
- \`low\` — minor / cosmetic.
- \`none\` — explicitly unprioritised.`,
  },
  {
    id: 'category-enum',
    title: 'Category convention',
    category: 'enum',
    tier: 'contextual',
    scope: 'global',
    namespace: 'forge',
    appliesTo: ['triage'],
    version: 1,
    render: () => `## Category convention
\`category\` is free text; Forge's recommended convention is one of:
- \`bug\` — something broken / regressed (keywords: broken, error, crash, fails).
- \`feature\` — net-new capability (keywords: add, new, support).
- \`improvement\` — enhance existing behaviour (keywords: improve, optimise, refine).
- \`task\` — chore / maintenance / config (keywords: update, bump, migrate).
Preserve a reporter-supplied category; only infer when missing.`,
  },
  {
    id: 'relations',
    title: 'Issue relation kinds',
    category: 'enum',
    tier: 'contextual',
    scope: 'global',
    namespace: 'forge',
    appliesTo: ['triage', 'plan'],
    version: 1,
    render: () => `## Issue relation kinds
Edges are directional \`fromIssue --kind--> toIssue\`. Allowed \`kind\` values:
- \`blocks\` — **the only dispatch-affecting kind.** A → blocks → B means B cannot dispatch until A's code is merged to the base branch — concretely, until A has \`merged_at\` set (stamped on leaving \`mergeStates.baseBranch\`, or via \`mark_merged\`) OR A is \`closed\`. It is NOT gated on A reaching \`released\`: a blocker parked at a manual release gate already unblocks B the instant its \`merged_at\` is stamped.
- \`relates\` — soft "see also"; PM/UX metadata only.
- \`duplicates\` — A duplicates B; metadata only.
- \`parent\` — A is the parent of B; metadata only.
- \`decomposes\` — epic → child; engages the system-owned decomposition lifecycle (see decompose-protocol). Do NOT create by hand outside that flow.
(Do not invent names like \`blocked_by\`/\`depends_on\` — those are not valid kinds.)`,
  },

  // ── Tier 2: process facts ───────────────────────────────────────────────
  {
    id: 'status-ladder',
    title: 'Status ladder (this project)',
    category: 'protocol',
    tier: 'contextual',
    scope: 'project-resolved',
    namespace: 'forge',
    appliesTo: ISSUE_STAGES,
    version: 2,
    render: (ctx) => {
      const ladder = ctx?.ladder?.length ? ctx.ladder : CANONICAL_LADDER;
      return `## Status ladder
This project's happy-path forward ladder (enabled stages only) — OVERRIDES the default chain in Pipeline Rules:
\`${ladder.join(' → ')}\`
Advance one step at a time as the FINAL action. Bounce states (\`needs_info\`, \`waiting\`, \`reopen\`, \`on_hold\`) are reachable from anywhere; \`draft\` is never a valid target.
This ladder is also the authoritative set of statuses. **If your adopted skill's exit table names a status that is not on it, that step is stale — advance to the ladder's next rung instead.** \`deploying\` is the recurring case: retired platform-wide, no row can hold it, and \`forge_issues.update\` rejects it outright. Skills are copied per project and do not receive template fixes, so a stale exit status is expected; do not burn a retry discovering it.`;
    },
  },
  {
    id: 'decompose-protocol',
    title: 'Decomposition protocol',
    category: 'protocol',
    tier: 'contextual',
    scope: 'global',
    namespace: 'forge',
    appliesTo: ['triage', 'plan'],
    version: 1,
    render: () => `## Decomposition protocol (system-owned)
When a parent is too large to ship atomically, decompose — but the lifecycle is system-owned; do NOT hand-set parent/child statuses.
1. Write each child's plan, then create children via \`forge_issues.create\` (Forge places them at \`draft\`).
2. Link each child to the parent with a \`decomposes\` relation (epic → child).
3. Core parks the parent at \`waiting\` (the human review gate).
4. A human approving the parent (→ \`approved\`) auto-cascades the children to \`approved\`.
5. The dispatcher holds the parent's own forward work until ALL children have \`merged_at\` set (or are \`closed\`) — i.e. each child's code is on the base branch; the parent then runs its integration LAST. A child unblocks the parent (and any \`blocks\` sibling) at the base-merge moment via \`merged_at\` — it does NOT need to reach \`released\`/\`closed\`. If a child merges its branch then parks at a manual gate, it MUST stamp its own \`merged_at\` (\`forge_issues.mark_merged target=base\`, see Pipeline Rules) or the parent and downstream siblings stall silently.
Manually moving a decompose parent or child breaks the kickoff.`,
  },
  {
    id: 'comment-authoring',
    title: 'Comment + status ordering',
    category: 'protocol',
    tier: 'contextual',
    scope: 'global',
    namespace: 'forge',
    appliesTo: ISSUE_STAGES,
    version: 1,
    render: () => `## Comment + status ordering
Post your findings/decision comment via \`forge_comments.create\` BEFORE the final \`forge_issues.update\` status change — the next pipeline step must see the comment already in place. Status is always the LAST action.`,
  },
  {
    id: 'memory-recall-first',
    title: 'Recall project memory before working',
    category: 'protocol',
    tier: 'contextual',
    scope: 'global',
    namespace: 'forge',
    // The stages where acting without prior context is the costliest mistake:
    // plan (wrong design vs an existing convention/decision), clarify
    // (re-deriving a repro/gotcha already recorded), fix (re-fixing a known
    // pattern). Other stages (triage/code/review/test/release) may still recall
    // at will — forge_memory is in the Tool Reference — but it is not mandated.
    // code is intentionally OUT: the orchestrator already injects a search-first
    // `preventiveContext` into code jobs, so mandating it here would duplicate.
    appliesTo: ['clarify', 'plan', 'fix'],
    version: 2,
    render: () => `## Recall memory first
Project memory is NOT auto-loaded into this prompt. BEFORE you design/reproduce/fix, recall what prior work already established for the area you are about to touch — conventions, gotchas, decisions, fix-patterns — so you neither contradict them nor rediscover from scratch:
\`forge_memory.search({ projectId, query: <the feature / file / error you're about to work on>, topK: 3, sourceFilter: ['knowledge', 'policy'] })\`
Run one or two focused queries on the concrete nouns of THIS task. Hits are point-in-time — verify against the live code/git before relying on them. Then REPORT the verification outcome for note/knowledge hits: \`forge_memory.feedback({ projectId, source, sourceRef, verdict: 'confirmed' })\` when the code agrees, or \`verdict: 'outdated', evidence: '<what disproved it>'\` to archive a stale row on the spot — a verification you don't report is a cleaning signal thrown away. This READ step is the counterpart to the "Capture Learnings" write step in Pipeline Rules.`,
  },

  // ── Tier 2: format facts ────────────────────────────────────────────────
  {
    id: 'release-notes-format',
    title: 'Release-notes field shape',
    category: 'format',
    tier: 'contextual',
    scope: 'global',
    namespace: 'forge',
    appliesTo: ['clarify', 'release'],
    version: 1,
    render: () => `## Release-notes shape
Seed \`releaseNotes\` via \`forge_issues.update\` as \`{ section, userFacing, technical }\`:
- \`section\` ∈ \`Added | Changed | Fixed | Removed | Security | Skip\` (\`Skip\` = internal-only, no changelog line).
- \`userFacing\` — one plain-language line for end users.
- \`technical\` — optional implementation detail.
forge-release appends this to the changelog at close; a null value on a user-facing issue forces a fallback seed.`,
  },
  {
    id: 'handoff',
    title: 'Step handoff payload',
    category: 'format',
    tier: 'contextual',
    scope: 'global',
    namespace: 'forge',
    // Only the stages with a handoff schema — `release`/`custom`/`pm` have
    // none, so injecting the generic "write a handoff" instruction there would
    // send the agent after a payload that cannot validate.
    appliesTo: Object.keys(HANDOFF_KEYS) as JobType[],
    version: 1,
    render: (ctx) => {
      const stage = ctx?.stage ?? null;
      const keys = stage ? HANDOFF_KEYS[stage] : undefined;
      const body = keys
        ? `For the \`${stage}\` step, call \`forge_step_handoff.write\` with: \`${keys}\`.`
        : 'Call `forge_step_handoff.write` with the structured payload for your step (triage/clarify/plan/code/review/test/fix each have a schema).';
      return `## Step handoff (best-effort)
${body}
Handoff is best-effort context for the next step; it never replaces the mandatory status advance. Finish by replying \`DONE\` on its own line as your final assistant text.`;
    },
  },

  // ── Tier 2: ops facts ───────────────────────────────────────────────────
  {
    id: 'worktree-protocol',
    title: 'Worktree isolation protocol',
    category: 'protocol',
    tier: 'contextual',
    scope: 'global',
    namespace: 'forge',
    appliesTo: ['code', 'fix'],
    version: 2,
    render: () => `## Worktree isolation
Implement on the ISS-* branch inside a dedicated git worktree under \`.claude/worktrees/iss-XX-short-title/\` — never check out branches in the main tree.
- Create on first entry; REUSE the existing worktree if it's already present (fix re-enters the one code created).
- Resolve collisions by reusing rather than recreating; clean up only at release.
- The root checkout is SHARED with other agents running right now. Never \`git checkout\`, \`git stash\`, \`git reset\` or \`git clean\` there. Uncommitted changes you find are very likely someone else's in-flight work; clobbering them is silent, and they cannot get it back.
- Resolve every path against your WORKTREE root, not the repo root — including "quick" edits to packages your issue only touches incidentally. An absolute repo-root path writes into whatever branch the shared tree happens to be on.
- Uncommitted changes already in your worktree that you did not make mean a prior attempt was interrupted. Inspect them and adopt or discard deliberately; never assume they are yours.
- **Your adopted skill's steps may still tell you to \`git checkout\` / \`git stash\` in the main tree. That text predates this protocol — this block wins.** Skills are copied per project and do not receive template fixes, so a stale procedure is expected; follow it for WHAT to build, not for where to stand.`,
  },
  // ISS-552 (C1) — trigger-phrased red-flag fact for code + fix stages.
  // Teaches by trigger condition (ISS-541: "if X happened, do Y"), not by
  // noun-list. Injected via the contextual tier; appliesTo keeps it out of
  // plan/review/triage where it would just be noise.
  {
    id: 'feedback-red-flag',
    title: 'Red flag: report friction you worked around',
    category: 'protocol',
    tier: 'contextual',
    scope: 'global',
    namespace: 'forge',
    appliesTo: ['code', 'fix'],
    version: 1,
    render: () => `## Red flag: report the friction
If you JUST worked around an ambiguous / contradictory / missing / redundant pipeline step (skill, tool, doc, orientation) to get unblocked, call \`forge_feedback\` (action=submit) BEFORE you finish — name the target + targetRef and what you expected vs what you hit. This is a trigger, not a checklist item: do it when the trigger fires, skip it when nothing snagged.`,
  },
] as const;

const FACT_BY_ID = new Map<string, ForgeFact>(FORGE_FACTS.map((f) => [f.id, f]));

export function getFact(id: string): ForgeFact | undefined {
  return FACT_BY_ID.get(id);
}

export function listFacts(opts?: { tier?: FactTier; namespace?: FactNamespace }): ForgeFact[] {
  return FORGE_FACTS.filter(
    (f) =>
      (opts?.tier ? f.tier === opts.tier : true) &&
      (opts?.namespace ? f.namespace === opts.namespace : true),
  );
}

/** Render a fact by id, or `undefined` if unknown (callers decide the marker). */
export function renderFact(id: string, ctx?: FactRenderContext): string | undefined {
  return FACT_BY_ID.get(id)?.render(ctx);
}
