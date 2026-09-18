import {
  SKILL_FACT_CATEGORIES,
  SKILL_FACT_NAMESPACES,
  SKILL_FACT_SCOPES,
  SKILL_FACT_TIERS,
} from '@forge/contracts';
import { describe, expect, it } from 'vitest';
import type { JobType } from '../../db/schema.js';
import { stepHandoffSchema } from '../../memory/step-handoff-schema.js';
import { RUNNER_CAPABILITIES } from '../../pipeline/registry.js';
import {
  CANONICAL_LADDER,
  FORGE_FACTS,
  getFact,
  listFacts,
  OPERATING_AFFORDANCES_TEXT,
  renderFact,
} from './registry.js';

describe('forge facts registry', () => {
  it('has unique fact ids', () => {
    const ids = FORGE_FACTS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every fact renders non-empty text', () => {
    for (const fact of FORGE_FACTS) {
      expect(fact.render({ projectId: 'p', stage: 'plan' }).trim().length).toBeGreaterThan(0);
    }
  });

  it('exactly two mandatory facts (pipeline-rules + mcp-tool-reference)', () => {
    const mandatory = listFacts({ tier: 'mandatory' })
      .map((f) => f.id)
      .sort();
    expect(mandatory).toEqual(['mcp-tool-reference', 'pipeline-rules']);
  });

  it('pipeline-rules keeps the load-bearing invariants', () => {
    const text = renderFact('pipeline-rules') ?? '';
    expect(text.startsWith('## Pipeline Rules')).toBe(true);
    expect(text).toContain('Status LAST');
    expect(text).toContain('The system never writes `waiting` by itself');
    // cm:guard the project-resolved ladder section must OVERRIDE the inline default chain, and the prompt has to say so in those words — two chains stated with no precedence between them is how an agent picks the wrong one, and the inline default is the copy that went stale (F1).
    expect(text).toContain('### Status ladder');
    expect(text).toContain('OVERRIDES the default');
    expect(text).toContain('forge_step_start');
    expect(renderFact('mcp-tool-reference')).toContain('forge_step_start');
  });

  it('pipeline-rules forbids fabricating a human decision (ISS-820)', () => {
    const text = renderFact('pipeline-rules') ?? '';
    expect(text).toContain('Never speak for a human');
    expect(text).toContain('QUOTE that human');
    expect(text).toContain('NEW `needs_info`');
    const fact = getFact('pipeline-rules');
    expect(fact?.version).toBe(10);
  });

  // cm:guard the prompt and the lifecycle guide must agree about `waiting`, and guides/registry.test.ts asserts the same three things — an agent reads the prompt, a human reads the guide, and the two disagreeing about who may write a status is how ISS-163 became six interventions
  it('pipeline-rules teaches the RFC 0002 park model and nothing of the deleted one', () => {
    const text = renderFact('pipeline-rules') ?? '';
    expect(text).toContain('a human is needed');
    expect(text).toContain('needs_decision');
    expect(text).toContain('needs_resource');
    expect(text).toContain('held');
    expect(text).not.toContain('operator_unblock');
    expect(text).not.toContain('Reopens are capped');
  });

  // cm:guard keep this in step with guides/registry.test.ts, which asserts the same of the guide a HUMAN reads. `needs` is what mints the question a park is answered through, and the rule reached no agent for the day it lived only in a `cm:guard` on the field — this is the assertion that the prompt carries it (ISS-996).
  it('pipeline-rules teaches the two fields a `needs_info` park takes, not one', () => {
    const text = renderFact('pipeline-rules') ?? '';
    expect(text).toContain('`needs`');
    expect(text).toContain('ANSWERED, not commented back to life');
    // cm:guard the FALSE half, kept as a negative because it read as true for eleven months and would read as true again to anyone editing this bullet: `reason` stopped being the only thing a reporter sees the day a park started minting a question.
    expect(text).not.toContain('it is the only place the reporter sees it');
  });

  it('mcp-tool-reference names forge_guide + the public /api/guides pointer (ISS-746)', () => {
    const text = renderFact('mcp-tool-reference') ?? '';
    expect(text).toContain('forge_guide');
    expect(text).toContain('/api/guides');
  });

  it('pipeline-rules carries the Operating affordances table + red flags (ISS-541)', () => {
    const text = renderFact('pipeline-rules') ?? '';
    expect(text).toContain('## Operating affordances');
    expect(text).toContain(OPERATING_AFFORDANCES_TEXT);
    expect(text).toContain('set_dependency kind:blocks');
    expect(text).toContain('draft');
    expect(text).toContain('forge_memory.search');
    expect(text).toContain('Forge red flags:');
    expect(text).toContain('What counts as an issue: guide `what-is-an-issue`');
  });

  it('Operating affordances names all six Forge red flags (criterion 4)', () => {
    for (const flag of [
      'prose-deps',
      'open-as-note',
      'wholesale-config-clobber',
      'skip-recall',
      'on_hold-from-draft',
      'fix-by-hand-and-forget',
    ]) {
      expect(OPERATING_AFFORDANCES_TEXT).toContain(flag);
    }
  });

  // cm:guard ISS-1047 — a fact whose `appliesTo` names no claimable job type renders for
  // nobody, which is what nine of them did for nine days after the staged lane was removed.
  // `RUNNER_CAPABILITIES` is derived here rather than listed, so retiring a job type there
  // turns this red instead of leaving a fact behind it.
  it('every contextual fact reaches at least one job type a runner can claim', () => {
    const claimable = new Set(Object.values(RUNNER_CAPABILITIES).flat());
    for (const fact of FORGE_FACTS) {
      if (!fact.appliesTo) continue;
      const reached = fact.appliesTo.filter((step) => claimable.has(step));
      expect(reached.length, `${fact.id} reaches no claimable job type`).toBeGreaterThan(0);
    }
  });

  it('no fact is offered to a pm job', () => {
    for (const fact of FORGE_FACTS) {
      expect(fact.appliesTo ?? [], fact.id).not.toContain('pm');
    }
  });

  // cm:guard the prose chain in PIPELINE_RULES and `CANONICAL_LADDER` are two copies of one sequence, and this is the only thing comparing them — the array's own guard used to say nothing did, which is how the prompt could state two ladders. It reads the array and searches the prose for it, so neither side is spelled twice here; a rung added to one alone leaves the other's chain unfindable and this goes red.
  it('the PIPELINE_RULES prose chain is the canonical ladder', () => {
    const rules = renderFact('pipeline-rules', { projectId: 'p', stage: 'code' }) ?? '';
    expect(rules).toContain(`\`${CANONICAL_LADDER.join(' → ')}\``);
  });

  it('handoff fact renders the per-stage payload keys', () => {
    expect(renderFact('handoff', { stage: 'plan' })).toContain('planSummary');
    expect(renderFact('handoff', { stage: 'review' })).toContain('verdict');
    expect(renderFact('handoff', { stage: 'pm' })).toContain('forge_step_handoff.write');
  });

  // cm:guard read the expectation off `stepHandoffSchema` and NEVER off a second copy of the key list — a literal spelled here too would make this pass while the prompt and the schema disagree, which is the whole failure it exists to catch. A `z.literal` field is one the write refuses to default, so a stage whose rendered text omits it briefs the agent into a 400; both discriminator fields were missing from all eight lists until ISS-953.
  it('every stage names the payload fields its schema branch will not default', () => {
    const branches = stepHandoffSchema.options as ReadonlyArray<{
      shape: Record<string, { def: { type: string; values?: readonly unknown[] } }>;
    }>;
    expect(branches.length).toBeGreaterThan(0);

    for (const branch of branches) {
      const literals = Object.entries(branch.shape).filter(([, f]) => f.def.type === 'literal');
      const stage = branch.shape.step?.def.values?.[0] as JobType;
      expect(stage, 'each branch is keyed on a step literal').toBeTruthy();
      expect(literals.length, `${stage} has literal-keyed fields`).toBeGreaterThan(1);

      const text = renderFact('handoff', { stage }) ?? '';
      for (const [field] of literals) {
        expect(text, `${stage} handoff text must name \`${field}\``).toContain(field);
      }
    }
  });

  it('every fact conforms to the @forge/contracts enum tuples (parity)', () => {
    for (const f of FORGE_FACTS) {
      expect(SKILL_FACT_CATEGORIES).toContain(f.category);
      expect(SKILL_FACT_TIERS).toContain(f.tier);
      expect(SKILL_FACT_SCOPES).toContain(f.scope);
      expect(SKILL_FACT_NAMESPACES).toContain(f.namespace);
    }
  });

  it('getFact returns undefined for unknown ids', () => {
    expect(getFact('nope')).toBeUndefined();
    expect(renderFact('nope')).toBeUndefined();
  });
});

/**
 * Worktree isolation is the one protocol whose violation destroys another
 * agent's work irrecoverably, and it has done so repeatedly: anhome
 * (redesign wiped twice), epodsystem-core (~30 min across 6 files),
 * brand-gateway (main tree switched to a sibling issue's branch mid-edit),
 * sidpeak (a crashed attempt kept committing into a reused worktree).
 *
 * Delivery was never the problem — the fact is `scope: global`,
 * `appliesTo: [code, fix]`, and `resolve.ts` injects contextual facts for
 * every applicable stage. It lost to the adopted skill's concrete
 * step-by-step `git checkout` / `git stash`, which the agent was actively
 * walking. Skills fork per project and never receive template fixes, so the
 * precedence clause here is the only statement that reaches all of them.
 */
describe('worktree-protocol fact — the invariant that must outrank a stale skill step', () => {
  const body = renderFact('worktree-protocol') ?? '';

  // cm:guard the membership rule is "every stage that writes code", and `drive` is one — it was missing until 2026-09-02, which left the ONE job type that runs unattended for an hour in a shared checkout with no worktree instruction at all. Assert the rule both ways: a stage that writes code and is absent is the leak, and a stage that writes none and is present tells a reader to build somewhere it has no business building.
  it('reaches every stage that writes code, and only those, globally', () => {
    const fact = getFact('worktree-protocol');
    expect(fact?.scope).toBe('global');
    for (const writes of ['code', 'fix', 'drive']) {
      expect(fact?.appliesTo, `${writes} writes code and needs the protocol`).toContain(writes);
    }
    for (const reads of ['triage', 'plan', 'review', 'test', 'release']) {
      expect(fact?.appliesTo, `${reads} writes no code`).not.toContain(reads);
    }
  });

  it('names every destructive op on the shared root, not just checkout', () => {
    for (const op of ['git checkout', 'git stash', 'git reset', 'git clean']) {
      expect(body, `missing prohibition: ${op}`).toContain(op);
    }
  });

  it("states the reason — the changes belong to someone else's live session", () => {
    expect(body).toMatch(/SHARED with other agents/);
    expect(body).toMatch(/cannot get it back/);
  });

  it('requires paths to resolve against the worktree root', () => {
    expect(body).toMatch(/WORKTREE root, not the repo root/);
  });

  it('tells the agent that foreign uncommitted changes are a prior attempt', () => {
    expect(body).toMatch(/prior attempt was interrupted/);
    expect(body).toMatch(/never assume they are yours/);
  });

  // cm:guard the precedence clause is load-bearing — without it the fact keeps losing to the forked skill body, which is exactly how this protocol failed on four projects.
  it('explicitly outranks a contradicting step in the adopted skill', () => {
    expect(body).toMatch(/this block wins/);
    expect(body).toMatch(/do not receive template fixes/);
  });
});

/**
 * The worktree lifecycle only closes if some stage is actually told to remove
 * one. `worktree-protocol` carried the sentence "clean up only at release"
 * while its own `appliesTo` was `[code, fix]` — so the single instruction to
 * delete anything was addressed to two stages that must NOT delete (fix and
 * review re-enter the same worktree) and invisible to the one that should.
 *
 * Measured 2026-08-14: ~200 abandoned worktrees across six runner boxes, one
 * project holding 17G / 1.69M files under `.claude/worktrees`, ubuntu6 down to
 * 951MB free on a 78G disk with every project on it failing.
 */
describe('worktree-cleanup fact — the half of the lifecycle that deletes', () => {
  const body = renderFact('worktree-cleanup') ?? '';

  // cm:guard the rule is "the stage after which nothing re-enters this worktree", not the literal `release`. On a staged project that is the release step; on an autonomous one it is `drive`, which merges and ships inside one session and has no successor at all — so `drive` belongs here for the same reason `code` and `review` must never appear, and dropping either entry restores the leak this fact exists to close.
  it('reaches the stages nothing follows, and none that re-enter the worktree', () => {
    const fact = getFact('worktree-cleanup');
    for (const last of ['release', 'drive']) {
      expect(fact?.appliesTo, `nothing re-enters the worktree after ${last}`).toContain(last);
    }
    for (const stage of ['code', 'fix', 'review', 'test']) {
      expect(fact?.appliesTo, `must not apply to ${stage}`).not.toContain(stage);
    }
  });

  // cm:guard the dirty check must come BEFORE the removal, and the removal must carry --force — `--force` is mandatory (node_modules is untracked) and is precisely what makes an unchecked removal destroy uncommitted work
  it('orders the dirty check ahead of the forced removal', () => {
    const check = body.indexOf('status --porcelain');
    const remove = body.indexOf('git worktree remove');
    expect(check).toBeGreaterThan(-1);
    expect(remove).toBeGreaterThan(check);
    expect(body).toContain('--force');
    expect(body).toMatch(/STOP/);
  });

  it('prunes the admin entry, not just the directory', () => {
    expect(body).toContain('git worktree prune');
  });

  // cm:guard a blanket sweep is the one thing this fact must never license — the reason it is a release-stage step and not a reaper is that only the releasing agent knows its own worktree is finished
  it("forbids sweeping other issues' worktrees", () => {
    expect(body).toMatch(/Never sweep other issues/);
    expect(body).toMatch(/work in progress right now/);
  });

  it('states the cost, so the step does not read as tidiness', () => {
    expect(body).toMatch(/GB each|node_modules/);
    expect(body).toMatch(/Nothing else ever removes it/);
  });
});

/**
 * `merged_at` is the pipeline's load-bearing lie. Six reports across five
 * projects: brand-gateway ISS-28 (closed + stamped + "Released — Merged to
 * master" while the commits sat only on the branch, with three children
 * queued behind it), epodsystem-core ISS-81 (stamped + tested, ISS-84
 * dispatched onto a base missing the code), pixelight ISS-182 (merged to
 * `testing` while prod publishes `main` — same bug reopened 3x in 2 days),
 * devbox ISS-4, getcontent ISS-161.
 *
 * The prompt layer already said plenty about merged_at — all of it "remember
 * to stamp it so downstream doesn't stall". Nothing said verify before you
 * stamp, and nothing said a blocker's stamp is not proof. Both halves now
 * live in the mandatory block, which every stage receives.
 */
describe('pipeline-rules — merged_at is caller-asserted, both directions', () => {
  const text = renderFact('pipeline-rules') ?? '';

  it('states plainly that nothing server-side verifies it', () => {
    expect(text).toMatch(/CALLER-ASSERTED/);
    expect(text).toMatch(/nothing server-side checks git/);
  });

  it('requires remote reachability before stamping, and handles the squash case', () => {
    expect(text).toMatch(/ON THE REMOTE/);
    expect(text).toContain('git merge-base --is-ancestor');
    expect(text).toMatch(/after a squash merge the sha never appears/);
  });

  it('rejects the three things agents actually substituted for evidence', () => {
    expect(text).toMatch(/push exit code/);
    expect(text).toMatch(/matching branch\s*names/);
    expect(text).toMatch(/the previous step said so/);
  });

  // cm:why the owner's own case — closing an abandoned issue unblocks its dependents.
  // cm:guard what this asserts moved on ISS-1100 and the move is the point: the text used to name
  // `unmark` as the UNDO, and it is not one. `unmark` withdraws the shipped-work claim; the
  // dependents are held by the issue's STATUS and `closed` releases them whatever `merged_at` says,
  // so the undo is moving the issue off `closed`. Asserting the old wording again is asserting a
  // remedy that does nothing.
  it('warns that closing unblocks dependents, and names an undo that works', () => {
    expect(text).toMatch(/[Cc]losing an abandoned issue whose code never landed does unblock/);
    expect(text).toContain('forge_issues.unmark');
    expect(text).toMatch(/does NOT put them back/);
    expect(text).toMatch(/[Mm]ove the issue back off `closed`/);
  });

  // cm:guard the READ side is the half nobody had stated — devbox ISS-4 had to discover by hand that a `closed` blocker's code was never on main.
  it("tells a dependent that a blocker's stamp is a claim, not proof", () => {
    expect(text).toMatch(/is a claim, not proof/);
    expect(text).toMatch(/do NOT silently build against it/);
    expect(text).toMatch(/do NOT merge\s*the blocker yourself/);
  });
});

/**
 * The mandatory block outranks the contextual worktree fact, so while it said
 * `git checkout <baseBranch> && git checkout -b ISS-XX` the worktree protocol
 * could never win — the four projects that lost work were following the
 * higher-precedence rule. Fixing the fact alone (d4f9f253) was not enough.
 */
describe('pipeline-rules — branch discipline defers to worktree isolation', () => {
  const text = renderFact('pipeline-rules') ?? '';

  it('no longer instructs a checkout in the shared root', () => {
    expect(text).not.toMatch(/git checkout <baseBranch> && git pull && git checkout -b/);
  });

  it('directs branch creation into the issue worktree and names the destructive ops', () => {
    expect(text).toContain('git worktree add');
    for (const op of ['git checkout', 'stash', 'reset', 'clean']) {
      expect(text, `missing prohibition: ${op}`).toContain(op);
    }
    expect(text).toMatch(/shared root checkout/);
  });
});

/**
 * 2026-08-07, finance-automation ISS-37: the test step found `main` missing the
 * branch its own skill told it forge-code had merged, merged it itself, deployed
 * — then read a 3-hour-old API outage as its own breakage and `git revert`ed the
 * reviewed merge off `main` (== liveBranch there) to "restore production".
 * Both halves were improvised: no skill mentions revert. The skill-layer topology
 * guard removes the motive; this rule removes the action, on every step.
 */
describe('pipeline-rules — no step rescues an environment with git', () => {
  const text = renderFact('pipeline-rules') ?? '';

  it('forbids revert / reset --hard / force-push on a shared branch', () => {
    for (const op of ['git revert', 'reset --hard', 'force-push']) {
      expect(text, `missing prohibition: ${op}`).toContain(op);
    }
  });

  it('reserves the base/production merge for the one step that owns it', () => {
    expect(text).toMatch(/no other step may merge there/);
  });

  it('names the report-and-park exit instead of a git rescue', () => {
    expect(text).toMatch(/post the evidence as a comment and set `waiting`/);
  });

  it('says why a single step cannot attribute an outage to itself', () => {
    expect(text).toMatch(/pre-existing outage/);
  });
});

/**
 * Third copy of the note/plan affordance rules (guide registry and the runner's
 * orientation template are the other two). It drifted the moment the first two
 * were fixed — the same copy-paste failure the skill layer has, one level up.
 */
describe('pipeline-rules — affordances table stays in sync with the guide + orientation', () => {
  const text = renderFact('pipeline-rules') ?? '';

  it('routes notes to memory and keeps draft for real queued work', () => {
    expect(text).toMatch(/nobody browses the issue list for notes/);
    expect(text).toMatch(/queue work that must actually happen LATER/);
  });

  it('warns against pre-filling plan / acceptanceCriteria', () => {
    expect(text).toMatch(/Pre-filling/);
    expect(text).toMatch(/written by the clarify\/plan steps/);
  });

  it('carries the current red-flag vocabulary', () => {
    for (const flag of ['draft-as-note', 'plan-by-hand', 'open-as-note', 'prose-deps']) {
      expect(text, `missing red flag: ${flag}`).toContain(flag);
    }
  });
});

/**
 * getcontent ISS-127: clarify reported "zero commits anywhere (local or
 * remote)", no `session_log` column, commit a8d709b nonexistent — and bounced
 * a valid issue to needs_info concluding its prerequisite ISS-126 had been
 * closed prematurely. The runner's checkout was 8 commits behind origin/main;
 * a plain `git fetch` showed the column, the commit and the whole merge chain.
 * Forge's own bookkeeping had been right the entire time.
 *
 * The second half matters as much: clarify also read "no ISS-126 branch" as
 * evidence, but branches are pruned after merge, so absence is the normal
 * post-merge state.
 */
describe('pipeline-rules — a stale clone is not evidence of absence', () => {
  const text = renderFact('pipeline-rules') ?? '';

  it('requires a fetch before concluding something does not exist', () => {
    expect(text).toMatch(/stale clone is not evidence of absence/);
    expect(text).toContain('git fetch origin');
    expect(text).toMatch(/many commits behind/);
  });

  it('points reads at the base branch rather than local HEAD', () => {
    expect(text).toContain('read `origin/<baseBranch>`, not your local');
  });

  // cm:guard the branch-absence half — without it the rule only covers half of what ISS-127 got wrong
  it('states that a missing ISS-* branch proves nothing after a merge', () => {
    expect(text).toContain('MISSING `ISS-XX-*` BRANCH proves nothing');
    expect(text).toMatch(/pruned after merge/);
    expect(text).toMatch(/git ls-remote/);
  });

  it('tells the agent to trust Forge over a disagreeing working copy until it fetches', () => {
    expect(text).toMatch(/fetch before you trust your copy/);
  });
});

describe('module-attribution (ISS-595)', () => {
  const fact = getFact('module-attribution');
  const MODULES = [
    { name: 'billing', parentName: null },
    { name: 'invoices', parentName: 'billing' },
  ];

  it('is contextual and project-resolved, so it never enters the byte-pinned preamble', () => {
    expect(fact?.tier).toBe('contextual');
    expect(fact?.scope).toBe('project-resolved');
  });

  // cm:guard `drive` ALONE since ISS-1047 — it was `[...ISSUE_STAGES, 'drive']`, and the nine
  // issue stages in that spread are job types no runner can claim.
  it('applies to the driver and to nothing else', () => {
    expect(fact?.appliesTo).toEqual(['drive']);
    expect(fact?.appliesTo).not.toContain('pm');
  });

  it('is relevant only to a project that has modules', () => {
    expect(fact?.relevant?.({ modules: MODULES })).toBe(true);
    expect(fact?.relevant?.({ modules: [] })).toBe(false);
    expect(fact?.relevant?.({})).toBe(false);
  });

  it('renders the field path and refuses the comment line', () => {
    const text = fact?.render({ modules: MODULES }) ?? '';
    expect(text).toContain('isPrimary: true');
    expect(text).toContain('forge_issues.update');
    expect(text).toContain('- invoices (under billing)');
    expect(text).toContain('is NOT the attribution');
  });

  // cm:guard the author-time surfaces (Skill Studio, GET /api/skill-facts) preview a fact with no project resolved and the registry invariant requires non-empty text from every one — so `render` may not be where the taxonomy gate lives
  it('still renders text with no project context, which is why the gate is `relevant`', () => {
    expect((fact?.render() ?? '').trim().length).toBeGreaterThan(0);
    expect(fact?.render()).toContain('no modules');
  });
});
