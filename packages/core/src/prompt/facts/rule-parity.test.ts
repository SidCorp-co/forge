/**
 * Cross-surface rule parity.
 *
 * Forge states the same operating rules in more than one place, and nothing
 * kept them in sync. On 2026-08-07 the note/plan affordance rules existed in
 * THREE copies — the guide registry, the runner's `.forge/orientation.md`
 * template, and the mandatory prompt block — and a fix to the first two left
 * the third (the one injected into every job) still teaching the behaviour it
 * was meant to remove. The worktree rule had the same shape: a contextual fact
 * said "never check out in the main tree" while the higher-precedence
 * `PIPELINE_RULES_TEXT` handed the agent a `git checkout` to run, so four
 * projects lost uncommitted work to the rule that was supposed to prevent it.
 *
 * This is the skill-fork problem one level up: the platform duplicates rules
 * across surfaces that no mechanism reconciles. These tests are that
 * mechanism. They assert INTENT, not bytes — the surfaces legitimately differ
 * in framing, escaping and audience, so byte-equality would just get disabled.
 *
 * cm:edge lockstep -> packages/runner/crates/forge-runner-core/src/workspace/orientation.rs — the runner template is the other copy of the affordance rules; edit one, this test fails until you edit the other
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPERATING_AFFORDANCES_TEXT, renderFact } from './registry.js';

// packages/core/src/prompt/facts → repo root
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..');
const ORIENTATION_RS = join(
  REPO_ROOT,
  'packages/runner/crates/forge-runner-core/src/workspace/orientation.rs',
);

/** Strip the escaping each surface needs so intent can be compared directly. */
function normalize(text: string): string {
  return text
    .replaceAll('\\`', '`')
    .replaceAll('\\n', '\n')
    .replaceAll('\\"', '"')
    .replace(/\s+/g, ' ');
}

const promptCopy = normalize(OPERATING_AFFORDANCES_TEXT);
const runnerCopy = normalize(readFileSync(ORIENTATION_RS, 'utf8'));

/**
 * One entry per rule that MUST read the same on every surface. Add a rule here
 * when you add it to either copy — that is the whole point of the file.
 */
const SHARED_AFFORDANCE_RULES: ReadonlyArray<{ rule: string; must: RegExp }> = [
  {
    rule: 'a note/learning/decision goes to memory, never an issue',
    must: /To record a note, learning, or decision \| `forge_memory[._]write`/,
  },
  {
    rule: 'nobody browses the issue list for notes (the reason draft is wrong too)',
    must: /nobody browses the issue list for notes/,
  },
  {
    rule: 'draft is for work that must actually happen later',
    must: /To queue work that must actually happen LATER \| create an issue at `draft`/,
  },
  {
    rule: 'open auto-triages and spawns a run',
    must: /Creating it at `open` — that auto-triages and spawns a pipeline run/,
  },
  {
    rule: 'a reporter fills title/description/priority/category and nothing else',
    must: /To report an issue \| fill `title`, `description`, `priority`, `category`/,
  },
  {
    rule: 'plan/acceptanceCriteria belong to the clarify/plan steps',
    must: /Pre-filling `plan`\/`acceptanceCriteria` — those are written by the clarify\/plan steps/,
  },
];

const SHARED_RED_FLAGS = [
  'prose-deps',
  'open-as-note',
  'draft-as-note',
  'plan-by-hand',
  'wholesale-config-clobber',
  'skip-recall',
  'on_hold-from-draft',
  'fix-by-hand-and-forget',
];

describe('rule parity — operating affordances (prompt preamble vs runner orientation)', () => {
  it.each(SHARED_AFFORDANCE_RULES)('both surfaces state: $rule', ({ must }) => {
    expect(promptCopy, 'missing from the prompt preamble').toMatch(must);
    expect(runnerCopy, 'missing from the runner orientation template').toMatch(must);
  });

  it.each(SHARED_RED_FLAGS)('both surfaces list the red flag %s', (flag) => {
    expect(promptCopy, 'missing from the prompt preamble').toContain(flag);
    expect(runnerCopy, 'missing from the runner orientation template').toContain(flag);
  });

  // cm:guard the exact row that survived two of three fixes on 2026-08-07 — if it comes back
  // anywhere, an agent is being taught to file notes as issues again.
  it('neither surface still routes a note to a draft issue', () => {
    const retired = /To record a note \/ follow-up \| create an issue at `draft`/;
    expect(promptCopy).not.toMatch(retired);
    expect(runnerCopy).not.toMatch(retired);
  });
});

/**
 * The worktree rule spans two prompt layers of DIFFERENT precedence:
 * `pipeline-rules` is `tier: mandatory`, `worktree-protocol` is contextual. A
 * contradiction there is not a style problem — the higher tier silently wins,
 * which is exactly how anhome, epodsystem-core, brand-gateway and sidpeak lost
 * uncommitted work while a fact told them not to.
 */
describe('rule parity — no prompt layer contradicts worktree isolation', () => {
  const pipelineRules = renderFact('pipeline-rules') ?? '';
  const worktree = renderFact('worktree-protocol') ?? '';

  it('the mandatory block never hands the agent an in-place checkout', () => {
    expect(pipelineRules).not.toMatch(/git checkout <baseBranch>/);
    expect(pipelineRules).not.toMatch(/git checkout .*&&.*git checkout -b/);
  });

  it('both layers forbid the same destructive ops on the shared root', () => {
    for (const op of ['checkout', 'stash', 'reset', 'clean']) {
      expect(pipelineRules, `mandatory block omits ${op}`).toContain(op);
      expect(worktree, `worktree fact omits ${op}`).toContain(op);
    }
  });

  it('both layers route branch creation through a worktree', () => {
    expect(pipelineRules).toContain('git worktree add');
    expect(worktree).toMatch(/dedicated git worktree/);
  });
});
