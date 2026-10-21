// REQ-48 BC-8: a note that says something the standing does not is refused, naming the field, so
// "Moving" can never sit above a stuck item the way FB-74 and REQ-45 read on 2026-10-21.

import { say } from '@forge/contracts/said';
import { waitingOn } from '@forge/contracts/standing';
import {
  basisFieldsOf,
  type ItemStanding,
  type StewardNoteWrite,
  standingBasisOf,
} from '@forge/contracts/steward';
import { describe, expect, it } from 'vitest';
import { claimsOfStanding, vetNote } from './vet.js';

const wait = waitingOn(
  'person',
  {
    who: say('standing.who.someone'),
    act: say('standing.act.takeOn', { key: 'ISS-284' }),
    rule: say('feedback.rule.draftCarrier', { key: 'ISS-284' }),
  },
  { ref: 'ISS-284' },
);
const times = {
  actClass: 'person_decide' as const,
  since: '2026-10-09T08:00:00.000Z',
  dueAt: '2026-10-13T08:00:00.000Z',
  stuck: {
    code: 'draft_carrier' as const,
    since: '2026-10-09T08:00:00.000Z',
    reason: 'ISS-284 is a draft, and nothing takes a draft on by itself.',
    via: 'ISS-284',
    says: { reason: say('standing.stuck.draftCarrier', { key: 'ISS-284' }) },
  },
  carriedBy: null,
};
const basis = standingBasisOf(basisFieldsOf({ ...times, group: 'stuck', waitingOn: wait }));
const standing: ItemStanding = {
  subject: { kind: 'feedback', id: 'f74', key: 'FB-74' },
  title: 'Export loses the last row',
  group: 'stuck',
  waitingOn: wait,
  note: null,
  ...times,
  basis,
};

const note = (over: Partial<StewardNoteWrite> = {}): StewardNoteWrite => ({
  lines: [
    'Routed to ISS-284 on 2026-10-09; it is still a draft, so nothing builds it.',
    'Next: take ISS-284 on, or route FB-74 elsewhere, by 2026-10-22.',
  ],
  cites: [{ kind: 'issue', ref: 'ISS-284' }],
  claims: claimsOfStanding(standing),
  basis,
  runId: null,
  ...over,
});

describe('the steward note vet', () => {
  it('passes a note whose every claim the standing reads', () => {
    expect(vetNote(note(), standing, [])).toEqual([]);
  });

  it('refuses a note that claims the stuck item is not stuck, naming the field and both values', () => {
    const refused = vetNote(
      note({ claims: { ...claimsOfStanding(standing), stuck: false, stuckCode: null } }),
      standing,
      [],
    );
    expect(refused.map((r) => [r.code, r.path])).toEqual([
      ['STEWARD_NOTE_CONTRADICTS', '/claims/stuck'],
      ['STEWARD_NOTE_CONTRADICTS', '/claims/stuckCode'],
    ]);
    expect(refused[0]?.detail).toBe('the note claims stuck false; the standing reads true.');
  });

  it('refuses a stuck item said to be moving in its lines, naming the line', () => {
    const refused = vetNote(
      note({ lines: ['Moving: ISS-284 is with the master.', 'Next: nothing, by 2026-10-22.'] }),
      standing,
      [],
    );
    expect(refused).toEqual([
      expect.objectContaining({ code: 'STEWARD_NOTE_CONTRADICTS', path: '/lines/0' }),
    ]);
  });

  it('refuses a note that does not cite the record the standing waits on', () => {
    const refused = vetNote(note({ cites: [{ kind: 'feedback', ref: 'FB-74' }] }), standing, []);
    expect(refused[0]).toMatchObject({ code: 'STEWARD_NOTE_CITE_MISSING', path: '/cites' });
  });

  it('refuses a cite no record answers, by its index', () => {
    const bad = { kind: 'issue' as const, ref: 'ISS-9999' };
    const refused = vetNote(note({ cites: [{ kind: 'issue', ref: 'ISS-284' }, bad] }), standing, [
      bad,
    ]);
    expect(refused[0]).toMatchObject({ code: 'STEWARD_NOTE_CITE_UNKNOWN', path: '/cites/1' });
  });

  it('refuses a note read against a standing that has since moved, naming the new basis', () => {
    const refused = vetNote(note({ basis: 'moving|agent|Master' }), standing, []);
    expect(refused[0]).toMatchObject({ code: 'STEWARD_NOTE_STALE', path: '/basis' });
    expect(refused[0]?.detail).toContain(basis);
  });
});
