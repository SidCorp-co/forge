// ISS-1126 (REQ-71 BC-13): the first trigger met cuts, in the order the policy declares; a count or
// target trigger also cuts at its maximum wait; `request` is the manual cut, never the sweep's. A
// project document naming a trigger that is none, or a bad number, is refused by name on write.
// @direct-test-of packages/core/src/release-batch/release-cutoff.ts
// @direct-test-of packages/core/src/project-config/documents.ts
// @direct-test-of packages/core/src/project-config/release-rule-schema.ts

import { SCHEMA_BASE } from '@forge/contracts/project-config';
import {
  RELEASE_CUTOFF_DEFAULT,
  type ReleaseCutoff,
  releaseCutoffOf,
} from '@forge/contracts/release-cutoff';
import { describe, expect, it } from 'vitest';
import { parseVersionedDocument } from '../project-config/documents.js';
import { projectDocumentSchema } from '../project-config/schema.js';
import { type CutoffItem, decideCutoff, soonestPending } from './release-cutoff.js';

const T0 = new Date('2026-11-08T10:00:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const item = (key: string, sinceMinutes = 0): CutoffItem => ({
  key,
  issueIds: [`${key}-issue`],
  since: at(sinceMinutes),
});
const cutoff = (...triggers: ReleaseCutoff['triggers']): ReleaseCutoff => ({
  triggers: [...triggers, { kind: 'request' }],
});

describe('decideCutoff', () => {
  it('cuts nothing and leaves nothing pending where nothing is eligible', () => {
    expect(decideCutoff(RELEASE_CUTOFF_DEFAULT, [], at(60))).toEqual({ cut: false, pending: [] });
  });

  it('time: waits until the oldest eligible outcome has waited its minutes, then cuts', () => {
    const items = [item('REQ-1', 0), item('FB-2', 4)];
    const before = decideCutoff(RELEASE_CUTOFF_DEFAULT, items, at(9));
    expect(before).toMatchObject({ cut: false });
    if (before.cut) return;
    expect(before.pending[0]?.endsAt).toEqual(at(10));
    expect(before.pending[0]?.says).toContain('REQ-1');
    // the boundary itself cuts
    expect(decideCutoff(RELEASE_CUTOFF_DEFAULT, items, at(10))).toMatchObject({
      cut: true,
      by: 'time',
    });
  });

  it('time 0 cuts as soon as an outcome is eligible', () => {
    const zero = cutoff({ kind: 'time', minutes: 0 });
    expect(decideCutoff(zero, [item('REQ-1')], at(0))).toMatchObject({ cut: true, by: 'time' });
  });

  it('count: cuts at its count, short of it only at its maximum wait (default 30)', () => {
    const three = cutoff({ kind: 'count', outcomes: 3 });
    const two = [item('REQ-1'), item('REQ-2', 1)];
    expect(decideCutoff(three, two, at(29))).toMatchObject({ cut: false });
    expect(decideCutoff(three, two, at(30))).toMatchObject({ cut: true, by: 'count' });
    expect(decideCutoff(three, [...two, item('FB-3', 2)], at(2))).toMatchObject({
      cut: true,
      by: 'count',
    });
    const short = cutoff({ kind: 'count', outcomes: 3, maxWaitMinutes: 5 });
    expect(decideCutoff(short, two, at(5))).toMatchObject({ cut: true, by: 'count' });
  });

  it('target: cuts once its outcome is eligible, or at its maximum wait', () => {
    const target = cutoff({ kind: 'target', outcome: 'REQ-90', maxWaitMinutes: 15 });
    expect(decideCutoff(target, [item('REQ-1')], at(14))).toMatchObject({ cut: false });
    expect(decideCutoff(target, [item('REQ-1')], at(15))).toMatchObject({
      cut: true,
      by: 'target',
    });
    expect(decideCutoff(target, [item('REQ-1'), item('REQ-90', 3)], at(3))).toMatchObject({
      cut: true,
      by: 'target',
      says: 'REQ-90 is eligible',
    });
  });

  it('the first trigger met cuts, and the soonest pending one is what a hold names', () => {
    const both = cutoff(
      { kind: 'time', minutes: 60 },
      { kind: 'count', outcomes: 2, maxWaitMinutes: 20 },
    );
    const one = [item('REQ-1')];
    const pending = decideCutoff(both, one, at(1));
    expect(pending).toMatchObject({ cut: false });
    if (pending.cut) return;
    expect(pending.pending.map((p) => p.kind)).toEqual(['time', 'count']);
    expect(soonestPending(pending.pending)?.kind).toBe('count');
    expect(decideCutoff(both, [...one, item('REQ-2')], at(1))).toMatchObject({ by: 'count' });
  });

  it('request alone never cuts in the sweep: it is the manual cut', () => {
    const manual: ReleaseCutoff = { triggers: [{ kind: 'request' }] };
    expect(decideCutoff(manual, [item('REQ-1')], at(10_000))).toEqual({
      cut: false,
      pending: [],
    });
  });
});

function document(release: Record<string, unknown> | undefined) {
  return {
    $schema: `${SCHEMA_BASE}/project-v1.json`,
    version: 1,
    project: { id: '11111111-1111-4111-8111-111111111111', slug: 'demo', name: 'Demo' },
    source: {
      type: 'git',
      git: { repository: 'github.com/o/r', defaultBranch: 'dev', branches: ['dev'] },
    },
    workspace: { isolation: 'worktree' },
    validation: { gate: { type: 'none' } },
    environments: {},
    promotions: [],
    rollback: { strategy: 'none' },
    execution: { plugin: { source: 'o/p', ref: 'a'.repeat(40) } },
    ...(release ? { release } : {}),
  };
}

const written = (triggers: unknown[]) =>
  parseVersionedDocument(
    projectDocumentSchema,
    document({ approval: { required: false }, cutoff: { triggers } }),
    'project',
  );

describe('release.cutoff on the project document', () => {
  it("reads Forge's default where the document declares none, and the document's where it does", () => {
    const none = parseVersionedDocument(projectDocumentSchema, document(undefined), 'project');
    expect(none.ok && releaseCutoffOf(none.value)).toEqual({
      cutoff: RELEASE_CUTOFF_DEFAULT,
      from: 'default',
    });
    const declared = written([
      { kind: 'count', outcomes: 3, maxWaitMinutes: 45 },
      { kind: 'request' },
    ]);
    expect(declared.ok && releaseCutoffOf(declared.value).from).toBe('project');
  });

  it('refuses an unknown trigger by name, listing the four', () => {
    const parsed = written([{ kind: 'weekly' }, { kind: 'request' }]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.refusals).toEqual([
      {
        code: 'RELEASE_TRIGGER_UNKNOWN',
        path: '/release/cutoff/triggers/0/kind',
        detail: expect.stringContaining('"weekly" is not a release trigger'),
      },
    ]);
    expect(parsed.refusals[0]?.detail).toContain('`time`, `count`, `target`, `request`');
  });

  it.each([
    [{ kind: 'time', minutes: -1 }, '/release/cutoff/triggers/0/minutes'],
    [{ kind: 'time', minutes: 2.5 }, '/release/cutoff/triggers/0/minutes'],
    [{ kind: 'time', minutes: 10_081 }, '/release/cutoff/triggers/0/minutes'],
    [{ kind: 'count', outcomes: 0 }, '/release/cutoff/triggers/0/outcomes'],
    [{ kind: 'count', outcomes: '3' }, '/release/cutoff/triggers/0/outcomes'],
    [
      { kind: 'count', outcomes: 3, maxWaitMinutes: 0 },
      '/release/cutoff/triggers/0/maxWaitMinutes',
    ],
    [{ kind: 'target', outcome: 'ISS-3' }, '/release/cutoff/triggers/0/outcome'],
    [{ kind: 'time', minutes: 5, extra: 1 }, '/release/cutoff/triggers/0/extra'],
  ])('refuses %j by name at its field', (trigger, path) => {
    const parsed = written([trigger, { kind: 'request' }]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    const [refusal] = parsed.refusals;
    expect(refusal?.path).toBe(path);
    expect(['RELEASE_TRIGGER_INVALID', 'UNKNOWN_KEY']).toContain(refusal?.code);
  });

  it('refuses a list without the direct request, and a kind declared twice', () => {
    const noRequest = parseVersionedDocument(
      projectDocumentSchema,
      document({
        approval: { required: false },
        cutoff: { triggers: [{ kind: 'time', minutes: 5 }] },
      }),
      'project',
    );
    expect(!noRequest.ok && noRequest.refusals[0]).toMatchObject({
      code: 'RELEASE_TRIGGER_INVALID',
      detail: expect.stringContaining('hotfix lane'),
    });
    const twice = written([
      { kind: 'time', minutes: 5 },
      { kind: 'time', minutes: 9 },
      { kind: 'request' },
    ]);
    expect(!twice.ok && twice.refusals[0]).toMatchObject({
      code: 'RELEASE_TRIGGER_INVALID',
      path: '/release/cutoff/triggers/1/kind',
    });
  });
});
