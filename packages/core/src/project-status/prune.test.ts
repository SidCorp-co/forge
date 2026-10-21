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
      shipped: { asOf: AT, releaseCount: 1, issueCount: 2 },
      waits: { asOf: AT, peopleCount: 1 },
      requirements: { asOf: AT, items: [{}] },
      late: { asOf: AT, items: [{}] },
      roadmap: { asOf: AT, now: [{}], next: [], later: [] },
    } as unknown as ProjectStatus;
    expect(pruneStatus(full).omitted).toBeNull();
  });
});
