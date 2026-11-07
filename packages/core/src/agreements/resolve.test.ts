// REQ-90: how a project's working agreements resolve, and what an agent is handed of them.
// @direct-test-of packages/core/src/agreements/resolve.ts
// @direct-test-of packages/core/src/agreements/supply.ts
// @direct-test-of packages/core/src/agreements/forge-defaults.ts
// @direct-test-of packages/core/src/prompt/carried.ts

import type { AgreementTask } from '@forge/contracts/agreements';
import { describe, expect, it } from 'vitest';
import { carriedIn } from '../prompt/carried.js';
import { currentRevision, FORGE_AGREEMENTS, type ForgeAgreement } from './forge-defaults.js';
import { type ProjectRevisionRow, resolveAgreements } from './resolve.js';
import { agreementsMapText, restatedRules } from './supply.js';

const at = new Date('2026-11-07T12:00:00Z');
const row = (
  r: Partial<ProjectRevisionRow> & Pick<ProjectRevisionRow, 'slug' | 'revision' | 'change'>,
): ProjectRevisionRow => ({
  name: null,
  rule: null,
  detail: null,
  condition: null,
  reason: 'because',
  baseRevision: null,
  actorUserId: 'u-1',
  actorName: 'Owner',
  at,
  ...r,
});
const BILLING_OVERRIDE = row({
  slug: 'proportional-verification',
  revision: 1,
  change: 'override',
  rule: 'Billing changes run the billing checks besides the scoped ones.',
  condition: { labels: ['billing'] },
  baseRevision: 1,
});
const task = (labels: string[]): AgreementTask => ({ issueId: null, labels, category: null });
const resolve = (
  rows: ProjectRevisionRow[],
  t: AgreementTask | null = null,
  forge = FORGE_AGREEMENTS,
) => resolveAgreements({ projectId: 'p-1', forge, rows, represented: [], task: t });
const one = (view: ReturnType<typeof resolve>, slug: string) =>
  view.agreements.find((a) => a.slug === slug);

describe('BC-13: the nine owner defaults ship as Forge agreements', () => {
  // REQ-90 r5 scopeIn, as agreed on 2026-11-07: the term, then the one-sentence default
  const OWNER_WORDS: Record<string, string> = {
    'Outcome-driven autonomy':
      'an agent chooses how and completes the goal within its granted authority, calling a person only for a decision beyond it.',
    'Proportional verification':
      "verify in proportion to a change's impact, widening the checks only on evidence; never verify beyond what the scope needs.",
    'Batch delivery':
      'related work goes in batches of at least one whole issue, checked in scope before it moves on; the full suite and CI run after the push, per batch.',
    'Continuous audit':
      'audit on a schedule or on real signals; simplifying, normalising and independent refactors happen there, while what bounds or proves the current fix stays in that fix.',
    'Progressive disclosure':
      'show by default what the current task and decision need, open detail on demand, and keep what changes a decision or why something is blocked visible at once.',
    'Single source of truth':
      'each decision has one authoritative source; a change updates it and what depends on it, and marks what is retired.',
    'Evidence-backed state':
      'state reflects its evidence and tells fixed, verified, released and confirmed on the target environment apart.',
    'Continuous improvement':
      'audit gates, prompts and skills too, and remove steps that make work wait or repeat once agents can do it; no process heavier than the work needs.',
    'Lean testing':
      'add a test only where it proves behaviour that matters or stops a specific regression the existing tests miss; extend an existing test first, and audit duplicate, stale and implementation-bound tests on a schedule.',
  };

  it.each(Object.entries(OWNER_WORDS))(
    '%s carries the owner sentence, its source and what it restates',
    (name, words) => {
      const a = FORGE_AGREEMENTS.find((f) => f.name === name) as ForgeAgreement;
      const rule = currentRevision(a).rule;
      expect(rule.charAt(0).toLowerCase() + rule.slice(1)).toBe(words);
      expect(a.source).toMatch(/2026-11-07 \(FB-5(69|70)\)/);
      expect(a.restates.length).toBeGreaterThan(0);
      expect(currentRevision(a).detail).toBeTruthy();
    },
  );

  it('shows every default on a project that changed nothing: the page never ships empty', () => {
    const view = resolve([]);
    expect(view.agreements.map((a) => a.state)).toEqual(FORGE_AGREEMENTS.map(() => 'inherited'));
    expect(view.counts.locked).toBe(2);
  });
});

describe('BC-2, BC-3: a project change resolves explicitly and is never silently erased', () => {
  it.each([
    ['an override written over the default in force', [BILLING_OVERRIDE], 'overridden'],
    [
      'an override restored',
      [
        BILLING_OVERRIDE,
        row({ slug: 'proportional-verification', revision: 2, change: 'restore' }),
      ],
      'inherited',
    ],
  ] as const)('%s reads %s', (_, rows, state) => {
    expect(one(resolve([...rows]), 'proportional-verification')?.state).toBe(state);
  });

  it('marks a newer Forge default Conflict, naming both, and keeps the project change in force', () => {
    const moved = FORGE_AGREEMENTS.map((a) =>
      a.slug === 'proportional-verification'
        ? {
            ...a,
            revisions: [
              ...a.revisions,
              { ...currentRevision(a), revision: 2, rule: 'Verify everything twice.' },
            ],
          }
        : a,
    );
    const got = one(
      resolve([BILLING_OVERRIDE], task(['billing']), moved),
      'proportional-verification',
    );
    expect(got?.state).toBe('conflict');
    expect(got?.conflict).toMatchObject({
      forge: { revision: 2 },
      project: { revision: 1, baseRevision: 1 },
    });
    expect(got?.effective).toMatchObject({ from: 'project', revision: 'project@1' });
  });

  it('never lets a project change a locked guarantee, even one written past the door', () => {
    const got = one(
      resolve([
        row({
          slug: 'access',
          revision: 1,
          change: 'override',
          rule: 'Anyone may do anything.',
          baseRevision: 1,
        }),
      ]),
      'access',
    );
    expect(got).toMatchObject({ locked: true, state: 'inherited', door: null });
    expect(got?.effective.rule).not.toContain('Anyone may');
  });

  it('adds a project-only agreement, and a retired one is no longer current', () => {
    const added = row({
      slug: 'release-window',
      revision: 1,
      change: 'addition',
      name: 'Release window',
      rule: 'Release on weekdays only.',
    });
    expect(one(resolve([added]), 'release-window')).toMatchObject({
      state: 'project_only',
      name: 'Release window',
    });
    expect(
      one(
        resolve([added, row({ slug: 'release-window', revision: 2, change: 'retire' })]),
        'release-window',
      ),
    ).toBeUndefined();
  });
});

describe('BC-6: a scoped override reaches only the task it names', () => {
  it.each([
    ['a billing task', ['billing'], 'project@1', 'Billing changes run'],
    ['a UI task', ['ui'], 'forge@1', 'Verify in proportion'],
  ])(
    '%s gets the matching verification rule, and the inherited batch rule',
    (_, labels, revision, words) => {
      const view = resolve([BILLING_OVERRIDE], task(labels));
      expect(one(view, 'proportional-verification')?.effective).toMatchObject({ revision });
      const map = agreementsMapText(view, 2, 'p-1') as string;
      expect(map).toContain(words);
      expect(map).toContain('**Batch delivery**');
    },
  );

  it('with no task, the map states the default and the condition under which the change holds', () => {
    const map = agreementsMapText(resolve([BILLING_OVERRIDE]), 2, 'p-1') as string;
    expect(map).toContain("Verify in proportion to a change's impact");
    expect(map).toContain('When label billing: Billing changes run');
  });
});

describe('BC-5, BC-7: what reaches a run is the effective text, and the run records its revision', () => {
  it('records each agreement the map carried at the revision in force, never an overridden default', () => {
    const view = resolve([BILLING_OVERRIDE], task(['billing']));
    const map = agreementsMapText(view, 2, 'p-1') as string;
    expect(map).not.toContain("Verify in proportion to a change's impact");
    const carried = carriedIn(map, [], [], view).filter((s) => s.kind === 'agreement');
    expect(carried).toContainEqual({
      kind: 'agreement',
      ref: 'proportional-verification',
      revision: 'project@1',
    });
    expect(carried).toContainEqual({ kind: 'agreement', ref: 'lean-testing', revision: 'forge@1' });
    expect(carried).toHaveLength(FORGE_AGREEMENTS.length);
  });

  it('points an always-on rule an agreement restates at that agreement, its namesake first', () => {
    const restated = restatedRules(resolve([]));
    expect(restated.get('batch-delivery')).toBe('Batch delivery');
    expect(restated.get('decision-authority')).toBe('Outcome-driven autonomy');
  });
});
