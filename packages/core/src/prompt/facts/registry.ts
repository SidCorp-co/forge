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

import type { IssueStatus, JobType } from "../../db/schema.js";

export type FactCategory = "enum" | "protocol" | "format" | "reference";
export type FactTier = "mandatory" | "contextual";
export type FactScope = "global" | "project-resolved";
export type FactNamespace = "forge" | "project";

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

const PIPELINE_RULES_TEXT = `## Pipeline Rules
- **Always advance the state — never leave an issue parked.** The FINAL action of every step MUST be a \`forge_issues.update\` that moves \`status\`. Setting status is what triggers the next step; an issue left in its current status stalls the pipeline forever. Do this even if your skill instructions don't mention a transition.
- **Single-shot turn — never background-and-exit.** Your step is ONE headless turn; when you stop, the whole process group is killed. Any \`run_in_background\` task dies with it and you never see its result — so NEVER end your turn while still waiting on background output (the job reports \`done\` but the issue is left parked, the silent stall above). To wait on an async result (deploy / build / migration), poll in the FOREGROUND so the turn blocks until you have the answer, then verify and set status. If the wait would exceed your budget, set the handoff status and exit cleanly — do NOT background-poll-and-exit. Backgrounding is fine ONLY for a helper you consume within the SAME turn (e.g. a dev server you query before finishing).
- **Where to move next.** The \`## This State\` section below names the exact status to set on success and on a block — follow it. Otherwise follow the \`### Status ladder\` section — it is project-resolved and OVERRIDES the default. Only when neither is present, default forward along: \`open → confirmed → clarified → approved → developed → testing → tested → released → closed\` (intermediate states you don't own auto-advance).
- **Deviate freely when warranted.** Transitions are NOT restricted to the happy path. From ANY state you may set \`needs_info\` (requirements missing/unclear), \`waiting\` (blocked on a human decision / can't proceed), \`reopen\` (regression or failed check), or \`on_hold\` (deliberate pause) the moment you hit that condition — don't force the ladder. Only \`draft\` is never a valid target.
- **You never self-rescue a crash.** If your job fails mechanically (process crash / non-zero exit), the SYSTEM reverts the issue to the stage's entry-status and re-dispatches automatically (retry budget + backoff); when the budget is exhausted it parks the issue at \`waiting\`. Do NOT set \`on_hold\` to "hold" a failure — \`on_hold\` is a deliberate pause only.
- **Decompose is system-owned — do NOT hand-set parent/child statuses.** When you decompose a parent into children, core parks the parent at \`waiting\` (the review gate) and creates the children at \`draft\`. A human approving the parent (→ \`approved\`) auto-cascades the children to \`approved\`. The parent's own forward work is held by the dispatcher until ALL children merge, then the parent runs its integration LAST. The kickoff is anchored to these system transitions — manually moving a decompose parent or child breaks it.
- **Status LAST**, after all other work (commits, comments, handoff). Do NOT set \`merged_at\` or other derived fields by hand — \`merged_at\` is stamped automatically when you leave \`released\`.
- **Branch discipline.** Run \`git branch --show-current\` + \`git status\` before any checkout. Branch from \`baseBranch\`: \`git checkout <baseBranch> && git pull && git checkout -b ISS-XX-short-title\`. Never switch branches mid-work.
- **ISS-* branch is source of truth.** Kept alive through the pipeline. Squash-merges to \`productionBranch\` at release.
- **Check in first.** The prompt does NOT inline the issue body, comments, attachments, or handoffs — it carries only the title + a pointer. Begin every step by calling \`forge_step_start\` (\`{ projectId, issueId, stage }\`) — it marks the issue in-flight when the step defines a working status (code/fix → \`in_progress\`) and returns your working bundle: full issue (with \`attachments[]\`), comments (each with \`attachments[]\`), prior step handoffs, resolved \`branchConfig\`. Never assume data from the prompt. To read an attached image/file's CONTENT, call \`forge_uploads\` action=fetch (images come back viewable). If the tool errors, fall back to \`forge_issues.get\` + \`forge_comments.list\` and set the working status yourself.

## Capture Learnings
Only when you hit a reusable lesson — a project convention, a non-obvious gotcha, or a fix pattern that will help a DIFFERENT agent on a DIFFERENT issue. If it's specific to this issue, it belongs in \`sessionContext\`, not memory.
1. Search first: \`forge_memory.search({ projectId, query, topK: 3, sourceFilter: ['knowledge'] })\`.
2. If nothing comes back scoring > 0.8, write it: \`forge_memory.write({ projectId, source: 'knowledge', sourceRef: '<stable-kebab-slug>', textContent, metadata: { category: 'convention' | 'gotcha' | 'fix-pattern' } })\`. Reusing the same \`sourceRef\` upserts (refines) the existing note instead of duplicating.
\`projectId\` comes from \`forge_issues.get\`. Keep \`textContent\` tight — one lesson, no issue-specific detail.

## Session Context (coding / fix / review tasks)
Before your final status update, update \`issues.sessionContext\` via \`forge_issues.update\`:
\`{ currentState, decisions, filesModified, errorsResolved, reviewFeedback, sessionCount, lastUpdated }\`
Merge with existing: increment sessionCount, append to arrays (skip duplicates), replace currentState. Cap arrays at 20.

## Output Rules
- Zero narration. Tool calls are self-documenting.
- Code only while implementing. No explanations between edits.
- Never repeat file contents after reading — just edit.
- One-line status at the end (e.g. "Plan written, set approved." or "Fix applied, pushed, set developed.").
- Comments go to \`forge_comments.create\`, not to chat output.`;

const TOOL_REFERENCE_TEXT = `## Tool Reference
- **forge_step_start** — step check-in: marks the issue in-flight (when the step has a working status) and returns the bundle {issue (with attachments[]), comments (each with attachments[]), handoffs, branchConfig} in one call. Idempotent; call FIRST on every step.
- **forge_issues** — list/get/create/update issues. get/update/transition return the issue with \`attachments[]\` ({id,name,mime,size,url}). update.documentId is required. Writable: title, description, status, priority, category, complexity, acceptanceCriteria, plan, sessionContext, relations.
- **forge_comments** — create requires issueDocumentId + body. list returns actor, body, isAI, timestamps, and \`attachments[]\` per comment.
- **forge_uploads** — attachment I/O. action=request mints a presigned upload URL (attach a file). action=fetch reads an EXISTING attachment by {target:"issue"|"comment", attachmentId} — images (png/jpeg/gif/webp) return as a viewable image block (vision), text/markdown inline; PDFs/video/oversized return metadata + download url only. Use fetch whenever an issue/comment references an attached image or file.
- **forge_memory** — per-project semantic memory. \`.search({projectId, query, topK, sourceFilter?})\` → scored hits; \`.write({projectId, source, sourceRef, textContent, metadata?})\` upserts on (projectId, source, sourceRef); \`.get\` for natural-key lookups, \`.delete\` to remove. Sources: issue, comment, job, note, knowledge, decision, policy.
- **forge_config** — read/write per-project settings: baseBranch, repoPath, productionBranch, categories, pipelineConfig, stateContext, projectFacts (+ projectFactsConfig for the always-inject tier).
- **forge_skills** — list available skills + per-project enable/disable.`;

// Canonical happy-path ladder — the single source of truth for the full
// status sequence (mirrors the line embedded in PIPELINE_RULES). The
// project-resolved `status-ladder` fact overrides this when `ctx.ladder` is
// given; `resolve.ts` imports it as the base its soft-skip filter starts from.
export const CANONICAL_LADDER: readonly IssueStatus[] = [
	"open",
	"confirmed",
	"clarified",
	"approved",
	"developed",
	"testing",
	"tested",
	"released",
	"closed",
];

// Issue-bound pipeline stages — facts that operate on an issue (status ladder,
// comments, handoff) apply here and are kept OUT of `pm` jobs, which have no
// issue to act on.
const ISSUE_STAGES: readonly JobType[] = [
	"triage",
	"clarify",
	"plan",
	"code",
	"review",
	"test",
	"release",
	"fix",
	"custom",
];

// ── Per-step handoff payload keys (mirror memory/step-handoff-schema.ts) ────
const HANDOFF_KEYS: Partial<Record<JobType, string>> = {
	triage: "summary, suggestedApproach, complexity, risks, affectedAreas",
	clarify:
		"outcome, environment, stepsVerified[], rootCauseHypothesis, openQuestions",
	plan: "planSummary, affectedFiles[], acceptanceChecklist[], unknowns",
	code: "filesModified[], decisions[], verificationCommands[], knownLimitations[], commitSha",
	review: "verdict, findings[], reviewedDiffSha",
	test: "result, failures[], flakyTests[]",
	fix: "filesModified[], decisions[], reviewItemsResolved[], knownLimitations[]",
};

export const FORGE_FACTS: readonly ForgeFact[] = [
	// ── Tier 1: mandatory (always auto-injected by system.ts) ───────────────
	{
		id: "pipeline-rules",
		title: "Pipeline rules & status discipline",
		category: "protocol",
		tier: "mandatory",
		scope: "global",
		namespace: "forge",
		version: 2,
		render: () => PIPELINE_RULES_TEXT,
	},
	{
		id: "mcp-tool-reference",
		title: "MCP tool reference",
		category: "reference",
		tier: "mandatory",
		scope: "global",
		namespace: "forge",
		version: 1,
		render: () => TOOL_REFERENCE_TEXT,
	},

	// ── Tier 2: issue-detail facts (enums + relations) ──────────────────────
	{
		id: "complexity-scale",
		title: "Complexity scale (t-shirt sizing)",
		category: "enum",
		tier: "contextual",
		scope: "global",
		namespace: "forge",
		appliesTo: ["triage", "plan"],
		version: 1,
		render: () => `## Complexity scale
\`complexity\` is t-shirt sizing for scope (NULL = unsized). Allowed values: \`xs\`, \`s\`, \`m\`, \`l\`, \`xl\`.
- \`xs\`/\`s\` — trivial / small, single-file or single-concern.
- \`m\` — medium, a few files in one area.
- \`l\`/\`xl\` — large / cross-cutting; a strong decompose signal (see decompose-protocol).`,
	},
	{
		id: "priority-scale",
		title: "Priority scale",
		category: "enum",
		tier: "contextual",
		scope: "global",
		namespace: "forge",
		appliesTo: ["triage"],
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
		id: "category-enum",
		title: "Category convention",
		category: "enum",
		tier: "contextual",
		scope: "global",
		namespace: "forge",
		appliesTo: ["triage"],
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
		id: "relations",
		title: "Issue relation kinds",
		category: "enum",
		tier: "contextual",
		scope: "global",
		namespace: "forge",
		appliesTo: ["triage", "plan"],
		version: 1,
		render: () => `## Issue relation kinds
Edges are directional \`fromIssue --kind--> toIssue\`. Allowed \`kind\` values:
- \`blocks\` — **the only dispatch-affecting kind.** A → blocks → B means B cannot dispatch until A reaches a terminal status (\`released\`/\`closed\`).
- \`relates\` — soft "see also"; PM/UX metadata only.
- \`duplicates\` — A duplicates B; metadata only.
- \`parent\` — A is the parent of B; metadata only.
- \`decomposes\` — epic → child; engages the system-owned decomposition lifecycle (see decompose-protocol). Do NOT create by hand outside that flow.
(Do not invent names like \`blocked_by\`/\`depends_on\` — those are not valid kinds.)`,
	},

	// ── Tier 2: process facts ───────────────────────────────────────────────
	{
		id: "status-ladder",
		title: "Status ladder (this project)",
		category: "protocol",
		tier: "contextual",
		scope: "project-resolved",
		namespace: "forge",
		appliesTo: ISSUE_STAGES,
		version: 1,
		render: (ctx) => {
			const ladder = ctx?.ladder?.length ? ctx.ladder : CANONICAL_LADDER;
			return `## Status ladder
This project's happy-path forward ladder (enabled stages only) — OVERRIDES the default chain in Pipeline Rules:
\`${ladder.join(" → ")}\`
Advance one step at a time as the FINAL action. Bounce states (\`needs_info\`, \`reopen\`, \`on_hold\`) are reachable from anywhere; \`draft\` is never a valid target.`;
		},
	},
	{
		id: "decompose-protocol",
		title: "Decomposition protocol",
		category: "protocol",
		tier: "contextual",
		scope: "global",
		namespace: "forge",
		appliesTo: ["triage", "plan"],
		version: 1,
		render: () => `## Decomposition protocol (system-owned)
When a parent is too large to ship atomically, decompose — but the lifecycle is system-owned; do NOT hand-set parent/child statuses.
1. Write each child's plan, then create children via \`forge_issues.create\` (Forge places them at \`draft\`).
2. Link each child to the parent with a \`decomposes\` relation (epic → child).
3. Core parks the parent at \`waiting\` (the human review gate).
4. A human approving the parent (→ \`approved\`) auto-cascades the children to \`approved\`.
5. The dispatcher holds the parent's own forward work until ALL children merge; the parent then runs its integration LAST.
Manually moving a decompose parent or child breaks the kickoff.`,
	},
	{
		id: "comment-authoring",
		title: "Comment + status ordering",
		category: "protocol",
		tier: "contextual",
		scope: "global",
		namespace: "forge",
		appliesTo: ISSUE_STAGES,
		version: 1,
		render: () => `## Comment + status ordering
Post your findings/decision comment via \`forge_comments.create\` BEFORE the final \`forge_issues.update\` status change — the next pipeline step must see the comment already in place. Status is always the LAST action.`,
	},
	{
		id: "memory-recall-first",
		title: "Recall project memory before working",
		category: "protocol",
		tier: "contextual",
		scope: "global",
		namespace: "forge",
		// The stages where acting without prior context is the costliest mistake:
		// plan (wrong design vs an existing convention/decision), clarify
		// (re-deriving a repro/gotcha already recorded), fix (re-fixing a known
		// pattern). Other stages (triage/code/review/test/release) may still recall
		// at will — forge_memory is in the Tool Reference — but it is not mandated.
		// code is intentionally OUT: the orchestrator already injects a search-first
		// `preventiveContext` into code jobs, so mandating it here would duplicate.
		appliesTo: ["clarify", "plan", "fix"],
		version: 1,
		render: () => `## Recall memory first
Project memory is NOT auto-loaded into this prompt. BEFORE you design/reproduce/fix, recall what prior work already established for the area you are about to touch — conventions, gotchas, decisions, fix-patterns — so you neither contradict them nor rediscover from scratch:
\`forge_memory.search({ projectId, query: <the feature / file / error you're about to work on>, topK: 3, sourceFilter: ['knowledge', 'policy'] })\`
Run one or two focused queries on the concrete nouns of THIS task. Hits are point-in-time — verify against the live code/git before relying on them. This READ step is the counterpart to the "Capture Learnings" write step in Pipeline Rules.`,
	},

	// ── Tier 2: format facts ────────────────────────────────────────────────
	{
		id: "release-notes-format",
		title: "Release-notes field shape",
		category: "format",
		tier: "contextual",
		scope: "global",
		namespace: "forge",
		appliesTo: ["clarify", "release"],
		version: 1,
		render: () => `## Release-notes shape
Seed \`releaseNotes\` via \`forge_issues.update\` as \`{ section, userFacing, technical }\`:
- \`section\` ∈ \`Added | Changed | Fixed | Removed | Security | Skip\` (\`Skip\` = internal-only, no changelog line).
- \`userFacing\` — one plain-language line for end users.
- \`technical\` — optional implementation detail.
forge-release appends this to the changelog at close; a null value on a user-facing issue forces a fallback seed.`,
	},
	{
		id: "handoff",
		title: "Step handoff payload",
		category: "format",
		tier: "contextual",
		scope: "global",
		namespace: "forge",
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
				: "Call `forge_step_handoff.write` with the structured payload for your step (triage/clarify/plan/code/review/test/fix each have a schema).";
			return `## Step handoff (best-effort)
${body}
Handoff is best-effort context for the next step; it never replaces the mandatory status advance. Finish by replying \`DONE\` on its own line as your final assistant text.`;
		},
	},

	// ── Tier 2: ops facts ───────────────────────────────────────────────────
	{
		id: "worktree-protocol",
		title: "Worktree isolation protocol",
		category: "protocol",
		tier: "contextual",
		scope: "global",
		namespace: "forge",
		appliesTo: ["code", "fix"],
		version: 1,
		render: () => `## Worktree isolation
Implement on the ISS-* branch inside a dedicated git worktree under \`.claude/worktrees/iss-XX-short-title/\` — never check out branches in the main tree.
- Create on first entry; REUSE the existing worktree if it's already present (fix re-enters the one code created).
- Resolve collisions by reusing rather than recreating; clean up only at release.`,
	},
] as const;

const FACT_BY_ID = new Map<string, ForgeFact>(
	FORGE_FACTS.map((f) => [f.id, f]),
);

export function getFact(id: string): ForgeFact | undefined {
	return FACT_BY_ID.get(id);
}

export function listFacts(opts?: {
	tier?: FactTier;
	namespace?: FactNamespace;
}): ForgeFact[] {
	return FORGE_FACTS.filter(
		(f) =>
			(opts?.tier ? f.tier === opts.tier : true) &&
			(opts?.namespace ? f.namespace === opts.namespace : true),
	);
}

/** Render a fact by id, or `undefined` if unknown (callers decide the marker). */
export function renderFact(
	id: string,
	ctx?: FactRenderContext,
): string | undefined {
	return FACT_BY_ID.get(id)?.render(ctx);
}
