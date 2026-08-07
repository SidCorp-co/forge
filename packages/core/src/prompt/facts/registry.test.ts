import {
  SKILL_FACT_CATEGORIES,
  SKILL_FACT_NAMESPACES,
  SKILL_FACT_SCOPES,
  SKILL_FACT_TIERS,
} from '@forge/contracts';
import { describe, expect, it } from 'vitest';
import {
  FORGE_FACTS,
  OPERATING_AFFORDANCES_TEXT,
  getFact,
  listFacts,
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
    expect(text).toContain('Decompose is system-owned');
    // The project-resolved ladder section takes precedence over the inline
    // default chain — guards against the two drifting silently (F1).
    expect(text).toContain('### Status ladder');
    expect(text).toContain('OVERRIDES the default');
    // Step check-in is the mandated first action (forge_step_start tool).
    expect(text).toContain('forge_step_start');
    expect(renderFact('mcp-tool-reference')).toContain('forge_step_start');
  });

  // AC5 token evidence (measured via renderFact + estimateTokens, no new
  // instrumentation): the mcp-tool-reference block grew 735 -> 766 estTokens
  // (+31, +111 chars) for this one bullet. A connected provider with a seeded
  // capability guide (e.g. coolify) adds another ~12 estTokens to its
  // preamble integrations bullet; providers without one are unaffected. On a
  // representative full pipeline preamble (pipeline-rules + tool-reference +
  // forge-facts + a per-stage state block, ~4090 estTokens) that is a ~0.8%
  // total growth in the common case and ~1.05% in the worst case (an
  // integration with a guide connected) — see FORGE_MCP_INSTRUCTIONS' own
  // guardrail test for the CLI-side number (net -77 chars, well under +50).
  it('mcp-tool-reference names forge_guide + the public /api/guides pointer (ISS-746)', () => {
    const text = renderFact('mcp-tool-reference') ?? '';
    expect(text).toContain('forge_guide');
    expect(text).toContain('/api/guides');
  });

  it('pipeline-rules carries the Operating affordances table + red flags (ISS-541)', () => {
    const text = renderFact('pipeline-rules') ?? '';
    // The canonical affordances block is appended into the mandatory
    // pipeline-rules so every job preamble teaches affordances as
    // trigger → tool → red-flag (not a noun-list).
    expect(text).toContain('## Operating affordances');
    expect(text).toContain(OPERATING_AFFORDANCES_TEXT);
    // The five affordances the issue requires + the red-flags list.
    expect(text).toContain('set_dependency kind:blocks');
    expect(text).toContain('draft');
    expect(text).toContain('forge_memory.search');
    expect(text).toContain('Forge red flags:');
    expect(text).toContain('docs/guides/forge-affordances.md');
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

  it('issue-bound facts are scoped away from pm jobs via appliesTo', () => {
    for (const id of ['status-ladder', 'comment-authoring', 'handoff']) {
      const fact = getFact(id);
      expect(fact?.appliesTo, id).toBeDefined();
      expect(fact?.appliesTo, id).not.toContain('pm');
    }
    // handoff only applies where a payload schema exists.
    expect(getFact('handoff')?.appliesTo).not.toContain('release');
    expect(getFact('handoff')?.appliesTo).toContain('fix');
  });

  it('status-ladder is project-resolved from ctx.ladder', () => {
    const resolved = renderFact('status-ladder', {
      projectId: 'p',
      ladder: ['open', 'confirmed', 'developed', 'testing', 'released'],
    });
    expect(resolved).toContain('open → confirmed → developed → testing → released');
    // Falls back to the default ladder when none is supplied.
    expect(renderFact('status-ladder')).toContain('open → confirmed → clarified');
  });

  it('handoff fact renders the per-stage payload keys', () => {
    expect(renderFact('handoff', { stage: 'plan' })).toContain('planSummary');
    expect(renderFact('handoff', { stage: 'review' })).toContain('verdict');
    // Unknown/absent stage degrades to the generic instruction.
    expect(renderFact('handoff', { stage: 'pm' })).toContain('forge_step_handoff.write');
  });

  it('relations fact states the real kinds and warns off invented names', () => {
    const text = renderFact('relations') ?? '';
    expect(text).toContain('blocks');
    expect(text).toContain('decomposes');
    expect(text).toContain('blocked_by'); // mentioned only to warn it is NOT valid
    expect(text).toContain('not valid kinds');
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

  it('reaches exactly the stages that write code, globally', () => {
    const fact = getFact('worktree-protocol');
    expect(fact?.scope).toBe('global');
    expect(fact?.appliesTo).toEqual(['code', 'fix']);
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

  // cm:guard the precedence clause is load-bearing — without it the fact keeps losing to the
  // forked skill body, which is exactly how this protocol failed on four projects.
  it('explicitly outranks a contradicting step in the adopted skill', () => {
    expect(body).toMatch(/this block wins/);
    expect(body).toMatch(/do not receive template fixes/);
  });
});

/**
 * `deploying` was retired platform-wide (db/schema.ts: removed from the
 * lifecycle, one-shot migrations re-parked every stranded row), but the
 * forked skill bodies still name it in their exit tables. Six reports across
 * four projects — portal-lighthuman x2, sid-desk x2, finance-automation,
 * pixelight — each burned a rejected `forge_issues.update` and then guessed a
 * fallback independently. The ladder is the only place that can correct all
 * fifteen forks at once.
 */
describe('status-ladder fact — authoritative over a stale exit status in a forked skill', () => {
  const body = renderFact('status-ladder', { projectId: 'p1', stage: 'code' }) ?? '';

  it('declares itself the authoritative status set, not just the happy path', () => {
    expect(body).toMatch(/authoritative set of statuses/);
  });

  // cm:guard naming `deploying` explicitly is the point — a generic "check the enum" loses to a
  // concrete numbered step the agent is already executing, which is how this failed six times.
  it('names `deploying` and says what to do instead', () => {
    expect(body).toContain('deploying');
    expect(body).toMatch(/retired platform-wide/);
    expect(body).toMatch(/advance to the ladder's next rung instead/);
  });

  it('explains why the skill is wrong, so the agent trusts the ladder over its steps', () => {
    expect(body).toMatch(/do not receive template fixes/);
  });

  it('still renders the project ladder it is resolved with', () => {
    const custom =
      renderFact('status-ladder', {
        projectId: 'p1',
        stage: 'code',
        ladder: ['open', 'approved', 'closed'],
      }) ?? '';
    expect(custom).toContain('open → approved → closed');
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

  // The owner's own case: closing an abandoned issue silently unblocks its dependents.
  it('warns that closing auto-stamps, and names the undo', () => {
    expect(text).toMatch(/[Cc]losing also auto-stamps/);
    expect(text).toContain('forge_issues.unmark');
  });

  // cm:guard the READ side is the half nobody had stated — devbox ISS-4 had to discover by hand
  // that a `closed` blocker's code was never on main.
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
