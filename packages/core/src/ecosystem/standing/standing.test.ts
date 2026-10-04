import { describe, expect, it } from 'vitest';
import {
  adoptionOf,
  type ContractFacts,
  type StandingViewer,
  standingOf,
  type VersionFact,
} from './standing.js';

const NOW = new Date('2026-10-04T12:00:00Z');
const at = (d: string) => new Date(`${d}T00:00:00Z`);

const v = (version: string, recorded: string, over: Partial<VersionFact> = {}): VersionFact => ({
  version,
  recordedAt: at(recorded),
  classification: 'non-breaking',
  approval: 'approved',
  decidedAt: at(recorded),
  ...over,
});

const ref = (slug: string) => ({ id: `${slug}-id`, slug, name: slug });

const provided = (over: Partial<ContractFacts> = {}): ContractFacts => ({
  direction: 'provided',
  providerSlug: 'hop',
  lifecycle: 'production',
  versions: [v('1.6.0', '2026-09-12'), v('1.2.0', '2026-05-02')],
  ours: null,
  windowDues: new Map(),
  change: null,
  consumers: [{ project: ref('care-bot'), builtAgainst: '1.6.0' }],
  requests: [],
  waits: [],
  ...over,
});

const consumed = (over: Partial<ContractFacts> = {}): ContractFacts => ({
  direction: 'consumed',
  providerSlug: 'bookings',
  lifecycle: 'production',
  versions: [v('1.4.0', '2026-08-12')],
  ours: '1.4.0',
  windowDues: new Map(),
  change: null,
  consumers: [{ project: ref('hop'), builtAgainst: '1.4.0' }],
  requests: [],
  waits: [],
  ...over,
});

const admin: StandingViewer = { decides: () => true, acts: true };
const member: StandingViewer = { decides: () => false, acts: true };
const agent: StandingViewer = { decides: (c) => c !== 'breaking', acts: false };

describe('standingOf: a contract this project provides', () => {
  it('is steady and says every consumer is on the current version', () => {
    const s = standingOf(provided(), admin, NOW);
    expect(s.state).toBe('published');
    expect(s.attentionGroup).toBe('steady');
    expect(s.waitingOn).toMatchObject({
      kind: 'none',
      who: 'Nobody',
      act: 'every consumer is on 1.6.0',
    });
    expect(s.adoption).toEqual(['current']);
  });

  it('waits on the viewer to decide a proposed version the viewer may decide', () => {
    const s = standingOf(
      provided({
        versions: [
          v('2.0.0', '2026-10-03', {
            approval: 'proposed',
            classification: 'breaking',
            decidedAt: null,
          }),
          v('1.6.0', '2026-09-12'),
        ],
      }),
      admin,
      NOW,
    );
    expect(s.state).toBe('proposed');
    expect(s.attentionGroup).toBe('needs_you');
    expect(s.waitingOn).toMatchObject({
      kind: 'you',
      act: 'approve or return 2.0.0 · measured breaking',
      ref: '2.0.0',
    });
    expect(s.current?.version).toBe('1.6.0');
    expect(s.pending?.version).toBe('2.0.0');
  });

  it('waits on an org admin when the viewer may not decide it: an agent never decides a breaking version', () => {
    const s = standingOf(
      provided({
        versions: [
          v('2.0.0', '2026-10-03', {
            approval: 'proposed',
            classification: 'breaking',
            decidedAt: null,
          }),
          v('1.6.0', '2026-09-12'),
        ],
      }),
      agent,
      NOW,
    );
    expect(s.attentionGroup).toBe('waiting');
    expect(s.waitingOn).toMatchObject({ kind: 'person', who: 'An org admin' });
  });

  it('ignores a proposed version older than the current one', () => {
    const s = standingOf(
      provided({
        versions: [
          v('1.6.0', '2026-09-12'),
          v('1.5.0', '2026-09-01', { approval: 'proposed', decidedAt: null }),
        ],
      }),
      admin,
      NOW,
    );
    expect(s.pending).toBeNull();
    expect(s.state).toBe('published');
  });

  it('waits on the viewer to reply to an incoming change request still in draft', () => {
    const s = standingOf(
      provided({
        requests: [
          {
            number: 'CRM-CR-2',
            direction: 'incoming',
            counterpart: 'clinic-crm',
            requirementKey: 'REQ-9',
            open: true,
          },
        ],
      }),
      member,
      NOW,
    );
    expect(s.attentionGroup).toBe('needs_you');
    expect(s.waitingOn).toMatchObject({
      kind: 'you',
      act: 'reply to clinic-crm',
      ref: 'REQ-9',
    });
  });

  it('does not wait on an agreed request', () => {
    const s = standingOf(
      provided({
        requests: [
          {
            number: 'CRM-CR-2',
            direction: 'incoming',
            counterpart: 'clinic-crm',
            requirementKey: 'REQ-9',
            open: false,
          },
        ],
      }),
      member,
      NOW,
    );
    expect(s.attentionGroup).toBe('steady');
  });

  it('waits on the lagging consumer while a breaking version window is open', () => {
    const s = standingOf(
      provided({
        versions: [
          v('2.0.0', '2026-10-01', { classification: 'breaking' }),
          v('1.6.0', '2026-09-12'),
        ],
        windowDues: new Map([['2.0.0', at('2026-10-09')]]),
        consumers: [
          { project: ref('clinic-crm'), builtAgainst: '1.6.0' },
          { project: ref('care-bot'), builtAgainst: '2.0.0' },
        ],
      }),
      admin,
      NOW,
    );
    expect(s.state).toBe('breaking_pending');
    expect(s.window).toEqual({ version: '2.0.0', dueAt: '2026-10-09T00:00:00.000Z', open: true });
    expect(s.adoption).toEqual(['owes', 'current']);
    expect(s.attentionGroup).toBe('waiting');
    expect(s.waitingOn).toMatchObject({
      kind: 'project',
      who: 'clinic-crm',
      act: 'adopt 2.0.0 by 2026-10-09',
    });
  });

  it('closes the window at its due instant: a consumer still behind is behind, and nobody is waited on', () => {
    const s = standingOf(
      provided({
        versions: [v('2.0.0', '2026-09-01', { classification: 'breaking' })],
        windowDues: new Map([['2.0.0', NOW]]),
        consumers: [{ project: ref('clinic-crm'), builtAgainst: '1.6.0' }],
      }),
      admin,
      NOW,
    );
    expect(s.window?.open).toBe(false);
    expect(s.state).toBe('published');
    expect(s.adoption).toEqual(['behind']);
    expect(s.attentionGroup).toBe('steady');
    expect(s.waitingOn.act).toBe('1 of 1 consumer behind, no window open');
  });

  it('reads unpublished with no approved version, and says it has no consumer', () => {
    const s = standingOf(provided({ versions: [], consumers: [] }), admin, NOW);
    expect(s.state).toBe('unpublished');
    expect(s.waitingOn.act).toBe('no consumer yet');
  });

  it('reads deprecated from the publication lifecycle', () => {
    expect(standingOf(provided({ lifecycle: 'deprecated' }), admin, NOW).state).toBe('deprecated');
  });
});

describe('standingOf: a contract this project consumes', () => {
  it('is steady on the latest version', () => {
    const s = standingOf(consumed(), member, NOW);
    expect(s.state).toBe('published');
    expect(s.ours).toBe('1.4.0');
    expect(s.waitingOn).toMatchObject({ kind: 'none', act: 'on the latest, 1.4.0' });
  });

  it('waits on the viewer to adapt while the breaking item is open, overdue or not', () => {
    for (const due of ['2026-11-02', '2026-10-01']) {
      const s = standingOf(
        consumed({ change: { feedback: 'FB-37', version: '2.0.0', dueAt: at(due), open: true } }),
        member,
        NOW,
      );
      expect(s.state).toBe('breaking_pending');
      expect(s.attentionGroup).toBe('needs_you');
      expect(s.waitingOn).toMatchObject({
        kind: 'you',
        act: `adapt to 2.0.0 by ${due}`,
        ref: 'FB-37',
      });
    }
  });

  it('hands the adaptation to a project member when the viewer is an agent', () => {
    const s = standingOf(
      consumed({
        change: { feedback: 'FB-37', version: '2.0.0', dueAt: at('2026-11-02'), open: true },
      }),
      agent,
      NOW,
    );
    expect(s.attentionGroup).toBe('waiting');
    expect(s.waitingOn).toMatchObject({ kind: 'person', who: 'A project member' });
  });

  it('owes nothing once the breaking item is closed', () => {
    const s = standingOf(
      consumed({
        change: { feedback: 'FB-37', version: '2.0.0', dueAt: at('2026-11-02'), open: false },
      }),
      member,
      NOW,
    );
    expect(s.attentionGroup).toBe('steady');
    expect(s.state).toBe('published');
  });

  it('waits on the provider to agree an outgoing request', () => {
    const s = standingOf(
      consumed({
        requests: [
          {
            number: 'HOP-CR-3',
            direction: 'outgoing',
            counterpart: 'bookings',
            requirementKey: 'REQ-31',
            open: true,
          },
        ],
      }),
      member,
      NOW,
    );
    expect(s.attentionGroup).toBe('waiting');
    expect(s.waitingOn).toMatchObject({
      kind: 'project',
      who: 'bookings',
      act: 'agree HOP-CR-3 · their REQ-31',
    });
  });

  it('waits on the provider to publish what its issues wait on', () => {
    const s = standingOf(
      consumed({
        waits: [
          { issue: 'ISS-1402', minVersion: '2.0.0' },
          { issue: 'ISS-1410', minVersion: '2.0.0' },
        ],
      }),
      member,
      NOW,
    );
    expect(s.attentionGroup).toBe('waiting');
    expect(s.waitingOn).toMatchObject({
      kind: 'project',
      who: 'bookings',
      act: 'publish ≥ 2.0.0 · 2 issues wait',
      ref: 'ISS-1402',
    });
  });

  it('reads behind when pinned below the current version', () => {
    const s = standingOf(consumed({ ours: '1.3.0' }), member, NOW);
    expect(s.state).toBe('behind');
    expect(s.waitingOn.act).toBe('built against 1.3.0; 1.4.0 is current');
  });

  it('never reads a proposed version as pending to a consumer', () => {
    const s = standingOf(
      consumed({
        versions: [
          v('2.0.0', '2026-10-03', { approval: 'proposed', decidedAt: null }),
          v('1.4.0', '2026-08-12'),
        ],
      }),
      member,
      NOW,
    );
    expect(s.pending).toBeNull();
    expect(s.current?.version).toBe('1.4.0');
  });
});

describe('adoptionOf', () => {
  const cur = v('2.0.0', '2026-10-01', { classification: 'breaking' });
  it('reads each standing of a consumer against the current version', () => {
    expect(adoptionOf('2.0.0', cur, null)).toBe('current');
    expect(
      adoptionOf('1.6.0', cur, { version: '2.0.0', dueAt: '2026-10-09T00:00:00.000Z', open: true }),
    ).toBe('owes');
    expect(
      adoptionOf('1.6.0', cur, {
        version: '2.0.0',
        dueAt: '2026-10-09T00:00:00.000Z',
        open: false,
      }),
    ).toBe('behind');
    expect(adoptionOf('1.6.0', null, null)).toBe('unpublished');
  });
});
