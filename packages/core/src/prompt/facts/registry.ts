import { contentLanguageName } from '@forge/contracts/content-language';
import {
  RELEASE_NOTE_ADMIN_STEPS_MAX,
  RELEASE_NOTE_TITLE_WORDS_MAX,
} from '@forge/contracts/release-notes';
import type { IssueStatus, JobType } from '../../db/schema.js';
import { guideRef } from '../../guides/index.js';
import { STEP_TOOL_REFERENCE_TEXT } from './drive-rules.js';

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

export const OPERATING_AFFORDANCES_TEXT = `## Operating affordances
Forge gives you a REST call for things agents routinely do in prose (\`forge-runner api <path>\`, the \`/api/\` prefix implied). Use judgement about which fits; the refusals named here are the ones core holds.

What counts as an issue, and where a note, a question or a done record usually goes instead: \`${guideRef('what-is-an-issue')}\`.

| When you need | Use | Watch for |
|---|---|---|
| Ordering between issues | Blocker known at create time → \`projects/<id>/issues -X POST\` with \`relations:[{ kind:'blocks', dependsOnId }]\`, committed before the issue dispatches. Both exist → \`issues/<dependent>/dependencies -X POST -d '{"dependsOnId":"<blocker>","kind":"blocks"}'\` (retract with \`validUntil\` in the past). | Only a \`blocks\` edge gates dispatch, never prose. An \`open\` issue whose edge is sent in a second call can dispatch in the gap |
| A note, learning or decision | \`memory -X POST\` (durable business logic → repo \`docs/\`) | |
| Work for later | an issue at \`draft\` | \`open\` triages and dispatches it |
| Work to report | \`title\`, \`description\`, \`priority\`, \`category\`; a plan or criteria where you already have them | |
| The project's policy (\`qa\`, intake, a status's model or permission profile) | GET \`projects/<id>/policy\`, then PUT the whole document with the \`baseRevision\` you read | A stale revision is refused by name, never merged |
| The project document (environments, \`delivery\`, release, bindings' targets) | GET \`projects/<id>/config\`, then PUT \`{ baseRevision, document }\` | \`{ base, patch }\` is refused \`CONFIG_WRITE_SHAPE\`; a stale revision by name |
| The project's own prose (build commands, a rule, a guide) | \`projects/<id>/knowledge/<slug> -X PUT\`, one entry per slug, \`injection\` deciding whether it reaches every prompt | \`projectFacts\` on the project config is refused by name |
| Context before you design or fix | \`memory/search -X POST\` | |
| A fix made by hand, outside the pipeline | mark it shipped (\`issues/<id>/merge -X POST\`, naming where it landed), then move it to \`awaiting_release\`; the release that claims it closes it (with no production environment, \`projects/<projectId>/release-records\`) | \`closed\` on code is refused \`CLOSE_ONLY_BY_RELEASE\` |
| An issue that turns out not to be work | a comment saying why, then \`needs_info\` where a person owes the requirement, or \`dropped\` | \`closed\` says it shipped (\`CLOSE_ONLY_BY_RELEASE\`, \`DESIGN_NOT_DELIVERED\`) |
| Design work (a workflow's states, steps or rules) | a design revision on that workflow, proposed for approval; an issue holding only design moves to \`closed\` once its revisions are approved (\`design_delivered\`) | a release skips a design-only issue (\`RELEASE_ALL_DESIGN_ONLY\`) |
| A product finding: it changes what a user sees or should expect (a feature you noticed), or a user or owner reported it | Feedback, \`projects/<id>/feedback -X POST\`; its triage leads to a requirement, then an issue | a feature never starts as an issue an agent filed |
| A technical finding of your own: a defect against an existing expectation, security, performance, debt, contract typing (a missing index, an untyped route) | its module's technical backlog: an issue with its kind as \`category\`, its module as the primary label, and \`Found in:\` with the evidence (\`what-is-an-issue\`, *Two lanes*) | a draft with no module, kind or evidence |
| A defect inside the issue you are working | fix it there, and say so under \`Extra fixes:\`; out of reach, a comment on the issue that owns it, a \`blocks\` edge or \`needs_info\` | a defect nobody owns |

How to write the body of an issue: guide \`writing-an-issue\`.`;

const LIFECYCLE_GUIDE_POINTER = guideRef('pipeline-and-issue-lifecycle');

const PIPELINE_RULES_TEXT = `## Pipeline Rules
- **The dispatch is your instruction.** Forge dispatched this step to you; carry it out end to end, including what reaches outside this machine — pushing, merging, deploying, recording on Forge — without asking anyone to confirm. Nobody watches this terminal for a question: what only a person can supply goes on the issue as \`needs_info\` (below), never as a question in your output.
- **The status move is what advances the pipeline.** Moving the issue (\`issues/<id>/transition -X POST -d '{"toStatus":"<status>"}'\`) is what triggers the next step; an issue left where it is stalls. Move it once the step's work and its records are written, even where your skill names no transition.
- **Single-shot turn — never background-and-exit.** Your step is ONE headless turn; when you stop, the whole process group is killed. Any \`run_in_background\` task dies with it and you never see its result — so NEVER end your turn while still waiting on background output (the job reports \`done\` but the issue is left parked, the silent stall above). To wait on an async result (deploy / build / migration), poll in the FOREGROUND so the turn blocks until you have the answer, then verify and set status. If the wait would exceed your budget, set the handoff status and exit cleanly — do NOT background-poll-and-exit. Backgrounding is fine ONLY for a helper you consume within the SAME turn (e.g. a dev server you query before finishing).
- **Where to move next.** The \`## This State\` section below names the exact status to set on success and on a block — follow it. Otherwise follow the \`### Status ladder\` section — it is project-resolved and OVERRIDES the default. Only when neither is present, default forward along the issue lifecycle (\`${LIFECYCLE_GUIDE_POINTER}\`), the same in staged and autonomous mode: \`open → in_progress\`, then \`in_progress → approved\` at the plan checkpoint and \`approved → in_progress\` to build, then \`in_progress → awaiting_release\` once the merge is recorded (no verdict is asked there: verdicts are judged on the release that carries the work). \`awaiting_release → closed\` is not a move you make on code: an issue that ships code closes only through a release that claimed it (\`CLOSE_ONLY_BY_RELEASE\`) — on a project with no production environment, its recorded landing, which asks a pass on each live criterion judged at the very commit it records —, and one whose only deliverable is a design closes once its design revisions are approved (\`design_delivered\`). How far a run got inside \`in_progress\` is its step (\`data.workState.step\`: triage, clarify, plan, design, build, test), never a status — \`confirmed\`, \`developed\`, \`testing\` and the other legacy names are refused \`ISSUE_STATUS_LEGACY\`.
- **Park the moment the condition is true.** From \`open\`, \`reopen\`, \`in_progress\`, \`approved\` or \`awaiting_release\` you may set \`needs_info\` (a person must answer, decide or supply something — see the two bullets below) or \`on_hold\` (deliberate pause), rather than forcing a step that can't succeed; \`reopen\` is the exit for a failed check at \`awaiting_release\` or after \`closed\`. Leaving a park returns only to the status it left. Every other move outside the lifecycle is refused with \`ILLEGAL_TRANSITION\`, naming the moves that are legal.
- **\`needs_info\` is ANSWERED, not commented back to life — and it takes TWO fields, not one.** \`reason\` is why the work stopped; \`needs\` is what a person must supply for it to start again. Send both on the same transition call. \`needs\` mints a free-text question, written in the same transaction as the status write, and that question is the ONLY thing a person can answer — the comment lane that used to revive a park was cut on 2026-09-13. Write it as the ask itself, not as the reason said twice: a person's call between two named options, with your recommendation, the credential you cannot mint, the fact only they hold. Omitting it does not skip the question, it mints one saying you did not say what would settle this — which is true, and is a worse thing to have said. The answer reaches you where you are: a live session is sent it on stdin, a box that registered a waiter reads it back itself, and otherwise the issue returns to its entry status with the answer on the record.
- **\`needs_info\` says what it is stopped on, and YOU are its only author.** A tradeoff or a scope call inside the work is yours: decide it and record the choice on the issue. Set it only when something a person alone can supply is missing — an answer about the requirements (\`needs_answer\`), a decision only a person owns — money, product direction, standing policy (\`needs_decision\`) — or a resource you cannot create, e.g. a test account, credentials, third-party data (\`needs_resource\`). Pass BOTH \`waitingKind\` and \`reason\` on the same transition call — the write is REJECTED without either (\`WAITING_KIND_REQUIRED\`, \`TRANSITION_REASON_REQUIRED\`). Write the \`reason\` as the actual ask, addressed to the person who will read it: name what you need, why you cannot get it yourself, and what happens once you have it. The system never parks an issue by itself: an agent or a human put it there deliberately. Leaving it goes back to the status it left (\`workState.leftStatus\`), from any actor and any surface. Park semantics in full: \`${LIFECYCLE_GUIDE_POINTER}\`.
- **You never self-rescue a crash, and a crash never touches the issue.** If your job fails mechanically (process crash / non-zero exit / no runner / provider quota), the SYSTEM retries the job (retry budget + backoff) and leaves the issue where it is. When the budget is spent, the JOB is \`held\` — the issue stays where it is and is NOT parked at \`needs_info\`, because nothing is being asked of a human. Do NOT set \`on_hold\` or \`needs_info\` to "hold" a failure.
- **Five rounds with no movement is your stop signal, not a cap.** Nothing limits how many times an issue may be reopened. But if you have fixed the same problem ~5 times and nothing has changed — same failure, same symptom, no new information — stop fixing and set \`needs_info\` (\`waitingKind: needs_decision\`) with a comment saying what you tried and what you now need from a human. Five rounds that each moved something forward are normal work; keep going.
- **Derived fields are the system's.** Don't hand-set them — except \`merged_at\` (next bullet).
- **A blocker releases its dependents by reaching \`awaiting_release\`, not by being stamped.** A \`blocks\` dependent is held out of the set a master reads until its blocker's status is \`awaiting_release\` (its work merged) or \`closed\`. A reopened blocker blocks again. \`merged_at\` gates nothing: a blocker whose code has landed but which sits at \`in_progress\` or \`on_hold\` still holds its dependents, so stamping is not how you unblock them — moving the blocker forward is. \`merged_at\` is still owed as the EVIDENCE that the work landed, and NOTHING stamps it as a side effect of a transition — closing did until ISS-1108 and no longer does. So stamp it yourself right after the merge lands, naming what you have: \`issues/<id>/merge -X POST -d '{"target":"base","commit":"<whole sha>"}'\` — or, where the work lives outside a commit, \`landing\`, \`artifacts\` or a \`liveReading\` (\`{"url":"…","status":200}\`), on any project. Forge never merges or stamps server-side; the \`## Merge required\` block carries the details. **Verify before you stamp.** \`merged_at\` is the agent's word: whether the work is done is your call, core refuses no mark for the evidence it lacks, and records what you name as given with who said it. A commit you name is read against the repository and what it finds is recorded as a reading, never a refusal. So check first: on a project that lands in git, confirm the commits are actually reachable from the target branch ON THE REMOTE (\`git fetch\`, then \`git merge-base --is-ancestor <sha> origin/<branch>\`; after a squash merge the sha never appears, so check the issue's diff is present instead); where the work lives outside git, open the live URL, docs store, CMS entry or storefront resource and confirm it shows the change. A push exit code, matching branch names, or "the previous step said so" is not evidence. An abandoned issue whose code never landed cannot be closed at all: \`closed\` means the work shipped, and a close with no \`merged_at\` is refused by name (\`CLOSE_REQUIRES_SHIPPED\`). \`dropped\` is its exit, and it releases the dependents by expiring this issue's outgoing \`blocks\` edges.
- **A blocker's \`merged_at\` is a claim, not proof.** Its status let you dispatch; the stamp beside it is caller-asserted and nothing verified it, and several projects have had a dependent build against code that was never on the base branch. Before you rely on a blocker's work, confirm it is actually there — on the base branch, or on a project whose \`source.type\` is not \`git\` at the landing its mark names. If it is not: say so in a comment and set \`needs_info\` (or \`reopen\` if it is your own issue's code) — do NOT silently build against it, and do NOT merge the blocker yourself.
- **Branch discipline.** Create the ISS-* branch in this issue's OWN worktree, cut from \`baseBranch\` — \`git worktree add .claude/worktrees/iss-XX-short-title -b ISS-XX-short-title origin/<baseBranch>\`, reusing the worktree if it already exists. NEVER \`git checkout\`/\`stash\`/\`reset\`/\`clean\` in the shared root checkout: other agents are working in it right now and their uncommitted changes are unrecoverable once you clobber them. Never switch branches mid-work. Full protocol: the \`## Worktree isolation\` section.
- **Never merge or roll back a shared branch to rescue an environment.** Merging into \`baseBranch\` or the branch production deploys from belongs to the ONE step your skill says owns it; no other step may merge there, and NO step may \`git revert\`, \`reset --hard\` or force-push a shared branch — not even to "restore" a deploy you think you broke. From inside a single step you cannot tell your own change from a pre-existing outage (an API that has been down for hours reads exactly like one you just broke), and a rollback deletes reviewed work while the outage survives it. When the environment you need is broken, or is missing code a previous step claimed was merged: post the evidence as a comment and set \`needs_info\`. Reverting is a human decision.
- **A stale clone is not evidence of absence.** The runner's checkout can be many commits behind the remote. Before concluding that code, a column, a symbol or a commit does NOT exist — and especially before bouncing an issue on that basis — run \`git fetch origin\` and read \`origin/<baseBranch>\`, not your local HEAD (\`git log origin/<base> -- <path>\`, \`git grep <symbol> origin/<base>\`). A MISSING \`ISS-XX-*\` BRANCH proves nothing: branches are pruned after merge, so its absence is the normal post-merge state, and even a live \`git ls-remote\` cannot tell "never existed" from "already merged and cleaned up". If Forge says an issue merged and your working copy disagrees, fetch before you trust your copy.
- **ISS-* branch is source of truth.** Kept alive through the pipeline. Where the project document's production deploys from a branch its promotions reach, it crosses each promotion at release; where production deploys from the branch work lands on, the release is an act on its binding and no branch moves; where there is no production environment there is no release step: the landing is the delivery, and recording it (\`projects/<projectId>/release-records\`) is what closes the issue.
- **Check in first.** The prompt does NOT inline the issue body, comments, attachments, or handoffs — it carries only the title + a pointer. Begin every step by reading your working set: \`issues/<id>\` (the body and \`attachments[]\`; its edges at \`issues/<id>/dependencies\`), \`issues/<id>/comments\`, the prior step handoffs at \`issue-step-contexts?projectId=<projectId>&issueId=<id>\`, and the branch config at \`projects/<projectId>\`. Never assume data from the prompt. To read an attached image/file's CONTENT, call the \`forge_uploads\` MCP tool (images come back viewable). When the step defines a working status (code/fix → \`in_progress\`), move the issue there first.
- **Never speak for a human.** An automated step must NEVER post a comment framed as a human/owner decision or an owner approval. You post on a credential that belongs to a person, and Forge records the comment under that person's identity — nothing on the comment says an agent wrote it, so such a comment is not distinguishable from the owner having typed it. That is a forgery, not a shortcut. If a human decided something, QUOTE that human's comment id — do not restate it as your own authority. Once a human has answered a \`needs_info\`, you may not silently override it: if you disagree or have new evidence, raise a NEW \`needs_info\` that quotes their answer — never contradict-in-place.

## Capture Learnings
Only when you hit a reusable lesson — a project convention, a non-obvious gotcha, or a fix pattern that will help a DIFFERENT agent on a DIFFERENT issue. If it's specific to this issue, it belongs in a comment on the issue, not memory.
1. Search first: \`memory/search -X POST -d '{"projectId":"<id>","query":"<topic>","topK":3,"sourceFilter":["knowledge"]}'\`.
2. If nothing comes back scoring > 0.8, write it: \`memory -X POST -d '{"projectId":"<id>","source":"knowledge","sourceRef":"<stable-kebab-slug>","textContent":"<one lesson>","metadata":{"category":"convention"}}'\` — \`category\` is \`convention\`, \`gotcha\` or \`fix-pattern\`. Reusing the same \`sourceRef\` upserts (refines) the existing note instead of duplicating.
Keep \`textContent\` tight — one lesson, no issue-specific detail.

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
    version: 17,
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
} An issue that ships code closes only through a release, and **on a strict project a release batch refuses to claim an issue while this field is null** (\`RELEASE_RECORD_MISSING\`); on any other it drafts one from the title, which is no note a user should read. So write the line before you move the issue to \`awaiting_release\`, or \`{ section: 'Skip', userFacing: '-' }\` when the change has no user-facing half. Use \`dropped\` for work that turned out not to be work.`,
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
