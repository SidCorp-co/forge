import { contentLanguageName } from '@forge/contracts/content-language';
import {
  RELEASE_NOTE_ADMIN_STEPS_MAX,
  RELEASE_NOTE_TITLE_WORDS_MAX,
} from '@forge/contracts/release-notes';
import type { IssueStatus, JobType } from '../../db/schema.js';
import { guideRef } from '../../guides/index.js';
import { affordanceRows } from './affordance-cards.js';
import { STEP_TOOL_REFERENCE_TEXT } from './drive-rules.js';
import { issueDoorsText } from './issue-doors.js';

type FactCategory = 'enum' | 'protocol' | 'format' | 'reference';
type FactTier = 'mandatory' | 'contextual';
type FactScope = 'global' | 'project-resolved';
type FactNamespace = 'forge' | 'project';

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
  /** The project's `kind='module'` labels, resolved by `./resolve.ts`. Empty
   *  or absent means the project has no taxonomy. */
  modules?: readonly ProjectModuleFact[];
  /** The project's content language tag (`vi`), which prose it stores in Forge is written in. */
  contentLanguage?: string;
}

export interface ProjectModuleFact {
  name: string;
  parentName: string | null;
}

export interface ForgeFact {
  /** Stable id used in `{{forge:<id>}}` and the REST surfaces. */
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
  /**
   * Whether this fact belongs in THIS project's prompt at all. Absent means always.
   *
   * Distinct from `appliesTo`, which gates on the stage and is known statically: this gates on
   * resolved project data, so a fact about a feature a project does not use costs that project
   * nothing. `render()` must still return text without it — the author-time surface (Skill
   * Studio) previews every fact regardless of any one project.
   */
  relevant?(ctx: FactRenderContext): boolean;
}

/**
 * The operating affordances table, rendered from the orientation's cards; `proposed` adds, by card id,
 * the situations a project's lessons folded into a card, shown as proposed until its code carries them.
 */
export const operatingAffordancesText = (
  proposed: ReadonlyMap<string, readonly string[]> = new Map(),
) => `## Operating affordances
Forge gives you a REST call for things agents routinely do in prose (\`forge-runner api <path>\`, the \`/api/\` prefix implied). Use judgement about which fits; the refusals named here are the ones core holds.

What counts as an issue, and where a note, a question or a done record usually goes instead: \`${guideRef('what-is-an-issue')}\`.

| When you need | Use | Watch for |
|---|---|---|
${affordanceRows(undefined, proposed)}

How to write the body of an issue: guide \`writing-an-issue\`.`;

export const OPERATING_AFFORDANCES_TEXT = operatingAffordancesText();

const LIFECYCLE_GUIDE_POINTER = guideRef('pipeline-and-issue-lifecycle');

const PIPELINE_RULES_TEXT = `## Pipeline Rules
- **The dispatch is your instruction.** Forge dispatched this step to you; carry it out end to end, including what reaches outside this machine — pushing, merging, deploying, recording on Forge — without asking anyone to confirm. Nobody watches this terminal for a question: what only a person can supply goes on the issue as \`needs_info\` (its door below), never as a question in your output.
- **The status move is what advances the pipeline.** Moving the issue (its door below) is what triggers the next step; an issue left where it is stalls. Move it once the step's work and its records are written, even where your skill names no transition. Where to: the \`## This State\` section names the status to set on success and on a block; else the \`### Status ladder\` section, which overrides the default; else the issue lifecycle (\`${LIFECYCLE_GUIDE_POINTER}\`). An issue closes when its criteria are met in scope; released and confirmed on the target environment are marks on the release, never statuses, and how far a run got inside \`in_progress\` is its step, never a status.
- **A tradeoff or a scope call inside the work is yours**: decide it and record the choice on the issue. A person is asked only for what you cannot supply: an answer about the requirements, a decision only a person owns — irreversible, real money, product direction, standing policy — or a resource you cannot create (a test account, a credential). How to ask is the transition door's card, below.
- **Single-shot turn — never background-and-exit.** Your step is ONE headless turn; when you stop, the whole process group is killed. Any \`run_in_background\` task dies with it and you never see its result — so NEVER end your turn while still waiting on background output (the job reports \`done\` but the issue is left parked, the silent stall above). To wait on an async result (deploy / build / migration), poll in the FOREGROUND so the turn blocks until you have the answer, then verify and set status. If the wait would exceed your budget, set the handoff status and exit cleanly — do NOT background-poll-and-exit. Backgrounding is fine ONLY for a helper you consume within the SAME turn (e.g. a dev server you query before finishing).
- **You never self-rescue a crash, and a crash never touches the issue.** If your job fails mechanically (process crash / non-zero exit / no runner / provider quota), the SYSTEM retries the job (retry budget + backoff) and leaves the issue where it is. When the budget is spent, the JOB is \`held\` — the issue stays where it is and is NOT parked at \`needs_info\`, because nothing is being asked of a human. Do NOT set \`on_hold\` or \`needs_info\` to "hold" a failure.
- **Five rounds with no movement is your stop signal, not a cap.** Nothing limits how many times an issue may be reopened. But if you have fixed the same problem ~5 times and nothing has changed — same failure, same symptom, no new information — stop repeating it: write on the issue what you tried and what each round showed, then change the approach (reread the cause, narrow the reproduction, bring in a reviewer or specialist where the kind of work needs one). A stuck fix is not by itself a person's decision: park at \`needs_info\` only when what is now missing is something a person alone owns — a decision only a person owns, or a resource you cannot create. Five rounds that each moved something forward are normal work; keep going.
- **A blocker's \`merged_at\` is a claim, not proof.** Its status let you dispatch; the stamp beside it is caller-asserted and nothing verified it, and several projects have had a dependent build against code that was never on the base branch. Before you rely on a blocker's work, confirm it is actually there — on the base branch, or on a project whose \`source.type\` is not \`git\` at the landing its mark names. If it is not: say so in a comment and set \`needs_info\` (or \`reopen\` if it is your own issue's code) — do NOT silently build against it, and do NOT merge the blocker yourself.
- **Never merge or roll back a shared branch to rescue an environment.** Merging into \`baseBranch\` or the branch production deploys from belongs to the ONE step your skill says owns it; no other step may merge there, and NO step may \`git revert\`, \`reset --hard\` or force-push a shared branch — not even to "restore" a deploy you think you broke. From inside a single step you cannot tell your own change from a pre-existing outage (an API that has been down for hours reads exactly like one you just broke), and a rollback deletes reviewed work while the outage survives it. When the environment you need is broken, or is missing code a previous step claimed was merged: post the evidence as a comment and set \`needs_info\`. Reverting is a human decision.
- **A stale clone is not evidence of absence.** The runner's checkout can be many commits behind the remote. Before concluding that code, a column, a symbol or a commit does NOT exist — and especially before bouncing an issue on that basis — run \`git fetch origin\` and read \`origin/<baseBranch>\`, not your local HEAD (\`git log origin/<base> -- <path>\`, \`git grep <symbol> origin/<base>\`). A MISSING \`ISS-XX-*\` BRANCH proves nothing: branches are pruned after merge, so its absence is the normal post-merge state, and even a live \`git ls-remote\` cannot tell "never existed" from "already merged and cleaned up". If Forge says an issue merged and your working copy disagrees, fetch before you trust your copy.
- **ISS-* branch is source of truth.** Kept alive through the pipeline. Where the project document's production deploys from a branch its promotions reach, it crosses each promotion at release; where production deploys from the branch work lands on, the release is an act on its binding and no branch moves; where there is no production environment there is no release step: the landing is the delivery, and today recording it (\`projects/<projectId>/release-records\`) is what closes the issue, a record that refuses no landing that happened.
- **Branch discipline.** Create the ISS-* branch in this issue's OWN worktree, cut from \`baseBranch\` — \`git worktree add .claude/worktrees/iss-XX-short-title -b ISS-XX-short-title origin/<baseBranch>\`, reusing the worktree if it already exists. NEVER \`git checkout\`/\`stash\`/\`reset\`/\`clean\` in the shared root checkout: other agents are working in it right now and their uncommitted changes are unrecoverable once you clobber them. Never switch branches mid-work. Full protocol: the \`## Worktree isolation\` section.
- **Check in first.** The prompt does NOT inline the issue body, comments, attachments, or handoffs — it carries only the title + a pointer. Begin every step by reading your working set: \`issues/<id>\` (the body and \`attachments[]\`; its edges at \`issues/<id>/dependencies\`), \`issues/<id>/comments\`, the prior step handoffs at \`issue-step-contexts?projectId=<projectId>&issueId=<id>\`, and the branch config at \`projects/<projectId>\`. Never assume data from the prompt. To read an attached image/file's CONTENT, call the \`forge_uploads\` MCP tool (images come back viewable). When the step defines a working status (code/fix → \`in_progress\`), move the issue there first.
- **Never speak for a human.** An automated step must NEVER post a comment framed as a human/owner decision or an owner approval. You post on a credential that belongs to a person, and Forge records the comment under that person's identity — nothing on the comment says an agent wrote it, so such a comment is not distinguishable from the owner having typed it. That is a forgery, not a shortcut. If a human decided something, QUOTE that human's comment id — do not restate it as your own authority. Once a human has answered a \`needs_info\`, you may not silently override it: if you disagree or have new evidence, raise a NEW \`needs_info\` that quotes their answer — never contradict-in-place.

${issueDoorsText({ besideTable: true })}

## Capture Learnings
When you learn something a DIFFERENT agent on a DIFFERENT issue would reuse — a convention, a non-obvious gotcha, a fix pattern — write it the moment you learn it; what is specific to this issue is a comment on the issue. Ask first whether code can hold it: how builders share code (a worktree per builder, an inventory a new route or door must join) is a code-standard rule, a gate, a default or a tool, never a memory. Search first (\`memory/search -X POST\`, \`"sourceFilter":["knowledge"]\`), update the entry already held (\`updates\`), and write one lesson with its four answers (\`value\`, \`type\`, \`scope\`, \`recheckWhen\`): \`memory -X POST\`, shaped as \`${guideRef('issue-flow')}\` step 7 says.

## Where people read you
Nobody reads this terminal. What a person should know — what you did, what you decided, what a reject found and why — goes on the issue as a comment (\`issues/<id>/comments -X POST\`), in your own words.

${OPERATING_AFFORDANCES_TEXT}`;

/** The happy path of workflow `issue-lifecycle`: the steps of a run are progress inside
 *  `in_progress`, never statuses (ISS-54). */
export const CANONICAL_LADDER: readonly IssueStatus[] = [
  'open',
  'in_progress',
  'approved',
  'in_progress',
  'awaiting_release',
  'closed',
];

const HANDOFF_KEYS: Partial<Record<JobType, string>> = {
  triage: 'summary, suggestedApproach, complexity, risks, affectedAreas',
  clarify: 'outcome, environment, stepsVerified[], rootCauseHypothesis, openQuestions',
  plan: 'planSummary, affectedFiles[], acceptanceChecklist[], unknowns',
  code: 'filesModified[], decisions[], verificationCommands[], knownLimitations[], commitSha',
  review: 'verdict, findings[], reviewedDiffSha',
  test: 'result, resultReason, failures[], flakyTests[]',
  fix: 'filesModified[], decisions[], reviewItemsResolved[], knownLimitations[]',
  drive: 'outcome, summary, workDone[], openQuestions[], commitSha',
};

const HANDOFF_UNIVERSAL_KEYS = 'step, schema_version: 1';

export const FORGE_FACTS: readonly ForgeFact[] = [
  {
    id: 'pipeline-rules',
    title: 'Pipeline rules & status discipline',
    category: 'protocol',
    tier: 'mandatory',
    scope: 'global',
    namespace: 'forge',
    version: 19,
    render: () => PIPELINE_RULES_TEXT,
  },
  {
    id: 'mcp-tool-reference',
    title: 'Reaching Forge',
    category: 'reference',
    tier: 'mandatory',
    scope: 'global',
    namespace: 'forge',
    version: 4,
    render: () => STEP_TOOL_REFERENCE_TEXT,
  },

  {
    id: 'release-notes-format',
    title: 'Release-notes field shape',
    category: 'format',
    tier: 'contextual',
    scope: 'global',
    namespace: 'forge',
    appliesTo: ['clarify', 'release', 'drive'],
    version: 8,
    render: (ctx) => `## Release-notes shape
Seed \`releaseNotes\` via \`forge-runner api issues/<id> -X PATCH\` as \`{ section, title, userFacing, technical, adminSteps }\`:
- \`section\` ∈ \`Added | Changed | Fixed | Removed | Security | Skip\` (\`Skip\` = nobody using the product sees it: counted apart, listed only in the developer view).
- \`title\` — the change's short name a user scans, at most ${RELEASE_NOTE_TITLE_WORDS_MAX} words, no code, keys or paths. Required on every section but \`Skip\`: a note without one is refused by name, and no reader cuts \`userFacing\` to make one.
- \`userFacing\` — the one plain-language sentence that says it in full, written in ${
      ctx?.contentLanguage
        ? `this project's content language, ${contentLanguageName(ctx.contentLanguage)} (\`${ctx.contentLanguage}\`)`
        : "this project's content language (its `## Content language` block names it)"
    } — never in the language of the issue's code or commits. The title is written in the same language.
- \`technical\` — optional implementation detail, shown only in the developer view.
- \`adminSteps\` — optional, at most ${RELEASE_NOTE_ADMIN_STEPS_MAX}: each one sentence an admin must do before this change goes out (run a migration, start a worker, grant a permission, approve a contract), in the same language. The release page lists them under "Before you release"; a step left only in \`technical\` is a step nobody is shown.
${
  ctx?.stage === 'drive'
    ? 'In this mode nothing dispatches after you, so **no later stage appends it** — if this project keeps a changelog, that line is yours, in the commit that carries the change.'
    : 'forge-release appends this to the changelog at close.'
} A release reads this note for the issue it carries, and **on a strict project a release batch refuses to claim an issue while this field is null** (\`RELEASE_RECORD_MISSING\`); on any other it drafts one from the title, which is no note a user should read. So write the line before you move the issue to \`awaiting_release\`, or \`{ section: 'Skip', userFacing: '-' }\` when the change has no user-facing half. Use \`dropped\` for work that turned out not to be work.`,
  },
  {
    id: 'handoff',
    title: 'Step handoff payload',
    category: 'format',
    tier: 'contextual',
    scope: 'global',
    namespace: 'forge',
    appliesTo: Object.keys(HANDOFF_KEYS) as JobType[],
    version: 5,
    render: (ctx) => {
      const stage = ctx?.stage ?? null;
      const keys = stage ? HANDOFF_KEYS[stage] : undefined;
      const call = '`forge-runner api issue-step-contexts -X POST`';
      const body = keys
        ? `For the \`${stage}\` step, call ${call} with \`payload\`: \`${HANDOFF_UNIVERSAL_KEYS}, ${keys}\`.`
        : `Call ${call} with the structured payload for your step (triage/clarify/plan/code/review/test/fix each have a schema). Every one of them carries \`${HANDOFF_UNIVERSAL_KEYS}\` inside \`payload\` alongside its own fields.`;
      const tail =
        stage === 'drive'
          ? 'Nothing dispatches after you, so this is not context for a next step — it is the summary of the turn a human reads on the issue.'
          : 'Handoff is best-effort context for the next step; it moves nothing — the status move does.';
      return `## Step handoff (best-effort)
${body}
${tail}`;
    },
  },

  {
    id: 'worktree-protocol',
    title: 'Worktree isolation protocol',
    category: 'protocol',
    tier: 'contextual',
    scope: 'global',
    namespace: 'forge',
    appliesTo: ['code', 'fix', 'drive'],
    version: 4,
    render: () => `## Worktree isolation
Implement on the ISS-* branch inside a dedicated git worktree under \`.claude/worktrees/iss-XX-short-title/\` — never check out branches in the main tree.
- Create on first entry; REUSE the existing worktree if it's already present (fix re-enters the one code created).
- Resolve collisions by reusing rather than recreating. Do NOT delete it when you finish — on a staged project \`fix\` and \`review\` re-enter this same worktree. Removal is asked for in exactly one place, the \`worktree-cleanup\` block: at the release step when a project has one, and at your own ship phase when you are the driver.
- The root checkout is SHARED with other agents running right now. Never \`git checkout\`, \`git stash\`, \`git reset\` or \`git clean\` there. Uncommitted changes you find are very likely someone else's in-flight work; clobbering them is silent, and they cannot get it back.
- Resolve every path against your WORKTREE root, not the repo root — including "quick" edits to packages your issue only touches incidentally. An absolute repo-root path writes into whatever branch the shared tree happens to be on.
- Uncommitted changes already in your worktree that you did not make mean a prior attempt was interrupted. Inspect them and adopt or discard deliberately; never assume they are yours.
- **Your adopted skill's steps may still tell you to \`git checkout\` / \`git stash\` in the main tree. That text predates this protocol — this block wins.** Skills are copied per project and do not receive template fixes, so a stale procedure is expected; follow it for WHAT to build, not for where to stand.`,
  },
  {
    id: 'worktree-cleanup',
    title: "Remove this issue's worktree at release",
    category: 'protocol',
    tier: 'contextual',
    scope: 'global',
    namespace: 'forge',
    appliesTo: ['release', 'drive'],
    version: 2,
    render: () => `## Remove this issue's worktree
The branch you just merged leaves a worktree behind at \`.claude/worktrees/iss-XX-short-title/\`, carrying its own \`node_modules\` and build cache — routinely 0.8-3 GB each. Nothing else ever removes it, so releasing without this step is how a runner box fills up and every project on it starts failing.

Remove ONLY this issue's worktree, once its branch has merged — that is the release step on a staged project, and your ship phase when you are the driver. Only after checking it:
1. \`git -C <worktree> status --porcelain\` — if any TRACKED file is modified, STOP. Do not remove it, and say so in your handoff: uncommitted work you did not author is someone's interrupted attempt, and it is unrecoverable once deleted. Untracked files (\`??\`) are build output and do not block removal.
2. \`git worktree remove .claude/worktrees/iss-XX-short-title --force\` from the repo root. \`--force\` is required (untracked build output) and is safe only because step 1 already cleared it.
3. \`git worktree prune\` — drops the stale admin entry so \`git worktree list\` stops naming a directory that is gone.

Never sweep other issues' worktrees, however old they look: a directory you did not create may hold an agent's work in progress right now.`,
  },
  {
    id: 'module-attribution',
    title: "The issue's primary module",
    category: 'protocol',
    tier: 'contextual',
    scope: 'project-resolved',
    namespace: 'forge',
    appliesTo: ['drive'],
    version: 2,
    relevant: (ctx) => (ctx.modules?.length ?? 0) > 0,
    render: (ctx) => {
      const modules = ctx?.modules ?? [];
      const list =
        modules.length > 0
          ? modules
              .map((m) => `- ${m.name}${m.parentName ? ` (under ${m.parentName})` : ''}`)
              .join('\n')
          : '- (this project declares no modules — nothing to attribute to)';
      return `## The issue's primary module
This project keeps a module taxonomy. Every module is a label with \`kind:"module"\`, and an issue may carry at most one PRIMARY module — the part of the product the work belongs to.

${list}

**Set it on the issue itself, never in a comment.** The carrier is the label attach payload: send the module as an OBJECT alongside any plain label strings —
\`forge-runner api issues/<id> -X PATCH -d '{"labels":[{"labelId":"<module name>","isPrimary":true},"needs-design"]}'\`
\`labelId\` takes the module's name or its uuid. \`labels\` REPLACES the set, so send the whole set in one call. A second primary in the same payload, or an \`isPrimary\` on something that is not a module, is refused — the write does not half-apply.

A \`**Module:**\` line in a comment is NOT the attribution and nothing reads it. If you find one, set the field and leave the comment alone.

When you are unsure which module fits, attach the labels you are sure of and leave the primary unset. An unattributed issue is a normal state, not a gap to fill by guessing — a wrong primary is worse than none, because it is what module filters and reports are counted from.`;
    },
  },
] as const;

const FACT_BY_ID = new Map<string, ForgeFact>(FORGE_FACTS.map((f) => [f.id, f]));
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
