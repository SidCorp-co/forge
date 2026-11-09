import type { ProjectStatus } from '@forge/contracts/project-status';
import { describe, expect, it } from 'vitest';
import { pruneStatus } from './prune.js';
import { shippedOf } from './read.js';
import { forgeProjectStatusTool } from './tool.js';

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

// ISS-1189 (FB-600): forge-dev served 0.4.0-dev.630, shipped with ISS-1182 and ISS-1186. Asked "which
// release is live and what did it ship", the bot's first read was this one; it named the version and
// no issue of it, and the bot answered "No landed release record is available".
describe('asked what is live, the status the chat reads', () => {
  const RELEASED = '2026-11-09T17:53:48.048Z';
  const verified = {
    level: 'none',
    proven: 0,
    total: 0,
    check: 'recorded',
    provider: null,
    judgedOn: null,
  };
  const issue = (key: string, title: string) => ({
    id: key,
    key,
    title,
    status: 'closed',
    proof: 'unrecorded',
    changeRequest: null,
  });
  const live = {
    version: '0.4.0-dev.630',
    state: 'shipped',
    current: true,
    releasedAt: RELEASED,
    name: 'Proven criteria hold through deploys',
    summary: 'A criterion that held before a deploy stays holding.',
    issueCount: 2,
    requirements: ['REQ-6'],
    contents: [
      {
        requirement: { key: 'REQ-6', title: 'Verdicts are typed records' },
        issues: [issue('ISS-1182', 'A pass judged on an earlier build')],
      },
      { requirement: null, issues: [issue('ISS-1186', "A requirement's standing names the cut")] },
    ],
    verified,
  };
  const next = {
    ...live,
    version: '0.4.0-dev.631',
    state: 'in_progress',
    current: false,
    releasedAt: null,
    name: 'The bell counts what it shows',
    issueCount: 1,
    contents: [],
  };
  const list = (serving: string | null) =>
    ({
      releases: [next, live],
      counts: {},
      approvalRequired: false,
      production: { ok: true, name: 'dev', url: 'https://forge-dev.example', serving },
      landings: [],
      endedRunHolds: [],
    }) as unknown as Parameters<typeof shippedOf>[0];
  const statusOf = (serving: string | null) =>
    pruneStatus({
      ...base,
      shipped: shippedOf(list(serving), [], [], new Date('2026-11-02T00:00:00.000Z'), AT),
    });

  it('carries the release record of the version production serves, with the issues it shipped', () => {
    const read = statusOf('0.4.0-dev.630');
    // what the model reads: before ISS-1189 it held 0.4.0-dev.630 and no issue of it
    const given = JSON.stringify(read.shipped);
    expect(given).toContain('ISS-1182');
    expect(given).toContain('ISS-1186');
    expect(read.shipped?.live).toEqual({
      version: '0.4.0-dev.630',
      record: {
        name: 'Proven criteria hold through deploys',
        state: 'shipped',
        releasedAt: RELEASED,
        issues: [
          { key: 'ISS-1182', title: 'A pass judged on an earlier build', requirement: 'REQ-6' },
          { key: 'ISS-1186', title: "A requirement's standing names the cut", requirement: null },
        ],
      },
    });
  });

  it('names the version it read and holds no record where no release wears it', () => {
    expect(statusOf('0.4.0-dev.632').shipped?.live).toEqual({
      version: '0.4.0-dev.632',
      record: null,
    });
  });

  it('names no live version where production serves none Forge read', () => {
    expect(statusOf(null).shipped?.live).toBeNull();
  });

  it('sends the chat to the one-release read it holds, by the name it holds it under', () => {
    const { description } = forgeProjectStatusTool(
      {} as Parameters<typeof forgeProjectStatusTool>[0],
    );
    expect(description).toContain('`live`');
    expect(description).toContain('forge_release');
  });
});
