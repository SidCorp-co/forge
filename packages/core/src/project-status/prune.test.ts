import type { ProjectStatus } from '@forge/contracts/project-status';
import { describe, expect, it } from 'vitest';
import { pruneStatus } from './prune.js';

// REQ-48 section 6: the chat read leaves out a section that holds nothing and names it in one line,
// never a run of zeros the model reads as a finding.

const AT = '2026-10-21T00:00:00.000Z';
const base = {
  projectId: 'p',
  slug: 'hop',
  name: 'Hop',
  asOf: AT,
  days: 7,
  viewer: { id: 'u', name: null },
  stuck: { asOf: AT, count: 1, items: [{ key: 'REQ-45' }] },
  needsYou: { asOf: AT, decisions: [], more: 0, total: 0 },
  shipped: { asOf: AT, releaseCount: 0, issueCount: 0 },
  inFlight: { asOf: AT, open: 4, runningCount: 1 },
  waits: { asOf: AT, peopleCount: 0, people: [] },
  requirements: { asOf: AT, items: [] },
  nextRelease: { asOf: AT, version: '0.4.0' },
  late: { asOf: AT, items: [] },
  roadmap: { asOf: AT, now: [], next: [], later: [] },
} as unknown as ProjectStatus;

const requirement = {
  key: 'REQ-7',
  title: 'Hop ships',
  state: 'in_delivery',
  criteria: { proven: 1, total: 2 },
  progress: { total: 2, shipped: 1, awaitingRelease: 1, toDo: 0 },
  waitingOn: {
    kind: 'release',
    who: 'Release',
    act: 'next release',
    rule: 'r',
    ref: null,
    dueAt: null,
    says: {},
  },
  delivery: {
    label: 'forecast',
    asOf: AT,
    landing: { label: 'forecast', asOf: AT, kind: 'landed', landedAt: AT },
    release: { kind: 'automatic', basis: { n: 822 } },
    inHands: { p50At: AT, p85At: AT, p50Minutes: 22, p85Minutes: 250 },
    shipped: null,
  },
  moved: null,
};

describe('the status the chat reads', () => {
  it('leaves out each section holding nothing, keeps the rest, and names what it left out in one line', () => {
    const out = pruneStatus(base);
    expect(
      Object.keys(out).filter(
        (k) => k in base && !['projectId', 'slug', 'name', 'asOf', 'days', 'viewer'].includes(k),
      ),
    ).toEqual(['stuck', 'inFlight', 'nextRelease']);
    expect(out.omitted).toBe(
      'Left out, holding nothing: needsYou, shipped, waits, requirements, late, roadmap.',
    );
  });

  it('says nothing was left out where every section holds something, and skips a section the read lacks', () => {
    const { stuck: _s, needsYou: _n, ...old } = base;
    const full = {
      ...old,
      shipped: { asOf: AT, releaseCount: 1, issueCount: 2, latest: null, releases: [] },
      waits: { asOf: AT, peopleCount: 1 },
      requirements: { asOf: AT, items: [requirement] },
      late: { asOf: AT, items: [{}] },
      roadmap: { asOf: AT, now: [{}], next: [], later: [] },
    } as unknown as ProjectStatus;
    expect(pruneStatus(full).omitted).toBeNull();
  });

  // debt 19747987: the full read was ~110 KB on forge and an MCP client refused it whole
  it("sends a release without its issue list and a requirement without its forecast's working", () => {
    const release = {
      version: '0.4.0-dev.627',
      releasedAt: AT,
      name: 'One',
      issueCount: 1,
      requirements: ['REQ-7'],
      contents: [{ requirement: { key: 'REQ-7', title: 'Hop ships' }, issues: [{ key: 'ISS-1' }] }],
      verified: {
        level: 'none',
        proven: 0,
        total: 0,
        check: 'recorded',
        provider: null,
        judgedOn: null,
      },
    };
    const out = pruneStatus({
      ...base,
      shipped: { asOf: AT, releaseCount: 1, issueCount: 1, latest: release, releases: [release] },
      requirements: { asOf: AT, items: [requirement] },
    } as unknown as ProjectStatus);
    const line = {
      version: '0.4.0-dev.627',
      releasedAt: AT,
      name: 'One',
      issueCount: 1,
      requirements: ['REQ-7'],
      verified: { level: 'none', proven: 0, total: 0 },
    };
    expect(out.shipped?.latest).toEqual(line);
    expect(out.shipped?.releases).toEqual([line]);
    expect(out.requirements?.items).toEqual([
      {
        key: 'REQ-7',
        title: 'Hop ships',
        state: 'in_delivery',
        criteria: { proven: 1, total: 2 },
        progress: { total: 2, shipped: 1, awaitingRelease: 1, toDo: 0 },
        waitingOn: { who: 'Release', act: 'next release', ref: null, dueAt: null },
        eta: { p50At: AT, p85At: AT, of: 'hands' },
        shipped: null,
      },
    ]);
  });
});
