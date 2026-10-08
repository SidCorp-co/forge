import { describe, expect, it } from 'vitest';
import { toMemoryHit } from './search.js';
import {
  type CiteContext,
  type CiteProject,
  issuePrefixSet,
  type ProjectHoldings,
  parseCites,
  resolveCites,
  staleRefsOf,
} from './stale-refs.js';

// MJ-3, MJ-6: a memory names sources; each is read where the text places it and linked, and the
// ones that no longer resolve are named back as why it reads stale. A closed issue or a deferred
// requirement still resolves. A key placed in a project the text does not name is never read
// against this project's numbers. MJ-5: a hit speaks as of its last write or confirmation.

const project = (
  id: string,
  slug: string,
  name = slug,
  active: string | null = null,
): CiteProject => ({
  id,
  slug,
  name,
  prefixes: issuePrefixSet({ active, held: [] }),
});
const HOP = project('p-hop', 'hop', 'HOP — Hospital Operations Platform');
const EPOD = project('p-epod', 'epod');
const CTX: CiteContext = { self: HOP, siblings: [HOP, EPOD], unreadable: new Set() };

const refsIn = (text: string) =>
  parseCites(text, CTX).map((c) => [c.kind, c.ref, c.project?.slug ?? null]);

const holdings = (over: Partial<ProjectHoldings> = {}): ProjectHoldings => ({
  issues: new Map(),
  requirements: new Map(),
  workflows: new Map(),
  releases: new Set(),
  repositoryWebUrl: null,
  ...over,
});

describe('a workflow a memory names (REQ-33 BC-4)', () => {
  const flows: CiteContext = { ...CTX, flows: ['referral-intake', 'intake'] };
  const WRITTEN = new Date('2026-10-01T00:00:00.000Z');

  it('reads a flow the project draws as a whole word in any case, never inside a longer one', () => {
    const cites = parseCites(
      'The Referral-Intake workflow asks first; intake2 and pre-intake do not count',
      flows,
    );
    expect(cites.map((c) => [c.kind, c.ref, c.project?.slug])).toEqual([
      ['workflow', 'referral-intake', 'hop'],
    ]);
    expect(parseCites('intake asks first', flows).map((c) => c.ref)).toEqual(['intake']);
    expect(parseCites('referral-intake asks first', CTX)).toEqual([]);
  });

  it('resolves it with its last change, and names it gone by name once the project no longer draws it', () => {
    const parsed = parseCites('referral-intake asks for consent', flows);
    const drawn = new Map([
      [HOP.id, holdings({ workflows: new Map([['referral-intake', WRITTEN]]) })],
    ]);
    expect(resolveCites(parsed, drawn)).toEqual([
      {
        ref: 'referral-intake',
        kind: 'workflow',
        project: 'hop',
        state: 'resolved',
        changedAt: WRITTEN.toISOString(),
      },
    ]);
    const gone = resolveCites(parsed, new Map([[HOP.id, holdings()]]));
    expect(staleRefsOf(gone, 'hop')).toEqual([
      { ref: 'referral-intake', kind: 'workflow', why: 'missing' },
    ]);
  });
});

describe('the sources a memory cites', () => {
  it('reads issue and requirement keys under the prefixes the project answers to, once each', () => {
    expect(refsIn('ISS-4 then REQ-2, ISS-4 again, HOP-9 and FB-3 (ISS-12)')).toEqual([
      ['issue', 'ISS-4', 'hop'],
      ['requirement', 'REQ-2', 'hop'],
      ['issue', 'ISS-12', 'hop'],
    ]);
  });

  it('reads a renamed project under its active prefix and every one it held', () => {
    const renamed = { ...HOP, prefixes: issuePrefixSet({ active: 'HOP', held: ['HOP', 'HP'] }) };
    const cites = parseCites('HOP-1, HP-2, ISS-3', {
      self: renamed,
      siblings: [renamed],
      unreadable: new Set(),
    });
    expect(cites.map((c) => c.ref)).toEqual(['HOP-1', 'HP-2']);
  });

  it('reads a key beside a sibling project in that project, by word or by slug#key', () => {
    expect(refsIn('the epod ISS-5 fix; see epod#ISS-6 and epod/REQ-2')).toEqual([
      ['issue', 'ISS-5', 'epod'],
      ['issue', 'ISS-6', 'epod'],
      ['requirement', 'REQ-2', 'epod'],
    ]);
  });

  it('reads a key the text places in a project it does not name as unchecked, never in this one', () => {
    expect(
      refsIn('From 2026-10-04 (dev core ISS-96, 4ff620437), records are kernel-written.'),
    ).toEqual([
      ['issue', 'ISS-96', null],
      ['commit', '4ff620437', 'hop'],
    ]);
  });

  it('reads a key beside a sibling the reader may not read exactly as one in a project it does not name (REQ-30 BC-10)', () => {
    const EPD = project('p-epd', 'epd', 'epd', 'EPD');
    const fenced: CiteContext = {
      self: HOP,
      siblings: [HOP, EPOD, EPD],
      unreadable: new Set([EPOD.id, EPD.id]),
    };
    const read = (text: string) =>
      parseCites(text, fenced).map((c) => [c.kind, c.ref, c.project?.slug ?? null]);
    expect(read('the epod ISS-5 fix; see epod#ISS-6 and epod/REQ-2')).toEqual([
      ['issue', 'ISS-5', null],
      ['issue', 'ISS-6', null],
      ['requirement', 'REQ-2', null],
    ]);
    // the same reading as a key in a project the text does not name, deduplicated with it
    expect(read('epod ISS-5 and core ISS-5')).toEqual([['issue', 'ISS-5', null]]);
    // an unreadable sibling's own prefix says nothing: a key under it is no cite at all
    expect(read('epd EPD-3 and core EPD-4')).toEqual([]);
    const held = new Map([[HOP.id, holdings()]]);
    expect(resolveCites(parseCites('epod ISS-5', fenced), held)).toEqual([
      { ref: 'ISS-5', kind: 'issue', project: null, state: 'unchecked' },
    ]);
  });

  it('does not carry a qualifier across a clause: the hop draft (2026-10-06, ISS-8) is this project', () => {
    expect(refsIn('core gotcha. Measured on the hop draft (2026-10-06, ISS-8).')).toEqual([
      ['issue', 'ISS-8', 'hop'],
    ]);
  });

  it('reads a commit sha but not a uuid, a number or a word, and a version as a release candidate', () => {
    expect(
      refsIn(
        'sha 779e4736a, run d097bf88-1c2e-4f5a-9b3c-1234567890ab, 3000000000, release 0.4.0-dev.112 and v0.2.0',
      ),
    ).toEqual([
      ['commit', '779e4736a', 'hop'],
      ['release', '0.4.0-dev.112', 'hop'],
      ['release', '0.2.0', 'hop'],
    ]);
  });
});

describe('resolving and linking what a memory cites', () => {
  const CHANGED = new Date('2026-10-05T08:00:00Z');
  const text =
    'ISS-1 ISS-2 ISS-3 ISS-4 REQ-1 REQ-2 REQ-3, epod ISS-1, core ISS-7, 779e4736a, 0.2.0 and 0.9.0';
  const held = new Map([
    [
      HOP.id,
      holdings({
        issues: new Map([
          [1, { status: 'closed', archived: false, updatedAt: CHANGED }],
          [2, { status: 'dropped', archived: false, updatedAt: CHANGED }],
          [3, { status: 'open', archived: true, updatedAt: CHANGED }],
        ]),
        requirements: new Map([
          [1, { status: 'deferred', updatedAt: CHANGED }],
          [2, { status: 'dropped', updatedAt: CHANGED }],
        ]),
        releases: new Set(['0.2.0']),
        repositoryWebUrl: 'https://github.com/acme/hop',
      }),
    ],
    [EPOD.id, holdings()],
  ]);
  const cites = resolveCites(parseCites(text, CTX), held);

  it('names a missing, dropped or archived record, and passes a closed issue or a deferred requirement', () => {
    expect(staleRefsOf(cites, 'hop')).toEqual([
      { ref: 'ISS-2', kind: 'issue', why: 'dropped' },
      { ref: 'ISS-3', kind: 'issue', why: 'archived' },
      { ref: 'ISS-4', kind: 'issue', why: 'missing' },
      { ref: 'REQ-2', kind: 'requirement', why: 'dropped' },
      { ref: 'REQ-3', kind: 'requirement', why: 'missing' },
      { ref: 'ISS-1', kind: 'issue', why: 'missing', project: 'epod' },
    ]);
  });

  it('dates each resolved issue and requirement by its last change, and no gone one', () => {
    expect(cites.filter((c) => c.changedAt).map((c) => [c.ref, c.project, c.changedAt])).toEqual([
      ['ISS-1', 'hop', CHANGED.toISOString()],
      ['REQ-1', 'hop', CHANGED.toISOString()],
    ]);
  });

  it("checks a sibling key against the sibling, and leaves an unnamed project's key unchecked", () => {
    expect(cites.find((c) => c.ref === 'ISS-1' && c.project === 'hop')?.state).toBe('resolved');
    expect(cites.find((c) => c.ref === 'ISS-1' && c.project === 'epod')?.state).toBe('gone');
    expect(cites.find((c) => c.ref === 'ISS-7')).toEqual({
      ref: 'ISS-7',
      kind: 'issue',
      project: null,
      state: 'unchecked',
    });
  });

  it('links a commit to the project repository and keeps only releases the project has', () => {
    expect(cites.find((c) => c.kind === 'commit')).toEqual({
      ref: '779e4736a',
      kind: 'commit',
      project: 'hop',
      state: 'unchecked',
      url: 'https://github.com/acme/hop/commit/779e4736a',
    });
    expect(cites.filter((c) => c.kind === 'release').map((c) => c.ref)).toEqual(['0.2.0']);
  });

  it('links a commit on a GitLab host under /-/commit/', () => {
    const lab = new Map([
      [HOP.id, holdings({ repositoryWebUrl: 'https://gitlab.example.com/acme/hop' })],
    ]);
    expect(resolveCites(parseCites('779e4736a', CTX), lab)[0]?.url).toBe(
      'https://gitlab.example.com/acme/hop/-/commit/779e4736a',
    );
  });
});

describe('a memory hit is dated', () => {
  const row = {
    id: 'm',
    source: 'note',
    sourceRef: 'r',
    text: 't',
    metadata: {},
    embeddedAt: new Date('2026-10-07T00:00:00Z'),
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-03T00:00:00Z'),
  };

  it('speaks as of its last write when nobody confirmed it since', () => {
    const hit = toMemoryHit({ ...row, lastVerifiedAt: null }, 1);
    expect(hit.writtenAt.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(hit.asOf.toISOString()).toBe('2026-10-03T00:00:00.000Z');
    expect(hit.verifiedAt).toBeNull();
  });

  it('speaks as of its confirmation when that is later', () => {
    const hit = toMemoryHit({ ...row, lastVerifiedAt: new Date('2026-10-05T00:00:00Z') }, 1);
    expect(hit.asOf.toISOString()).toBe('2026-10-05T00:00:00.000Z');
  });
});
