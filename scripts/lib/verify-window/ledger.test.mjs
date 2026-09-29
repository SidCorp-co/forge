import { describe, expect, it } from 'vitest';
import { readManifest, renderLedger } from './ledger.mjs';

const head = 'a'.repeat(40);
const member = { issue: 'ISS-1', branch: 'ISS-1-x', head, arrivedAt: '2026-09-29T10:00:00Z' };

describe('readManifest', () => {
  it.each([
    [
      { window: 'Bad Id', base: 'main', members: [member] },
      /`window` must be a lowercase kebab id/,
    ],
    [{ window: 'w1', members: [member] }, /`base` must name the branch/],
    [{ window: 'w1', base: 'main', members: [] }, /at least one member/],
    [
      { window: 'w1', base: 'main', members: [{ ...member, head: 'abc' }] },
      /full 40-character commit/,
    ],
    [{ window: 'w1', base: 'main', members: [member, member] }, /ISS-1 is listed twice/],
  ])('refuses %j by name', (raw, want) => {
    expect(readManifest(raw).refusal).toMatch(want);
  });

  it('reads a well-formed manifest with an empty isolation list', () => {
    expect(
      readManifest({ window: 'w1', base: 'main', members: [member] }).manifest.isolated,
    ).toEqual([]);
  });
});

describe('renderLedger', () => {
  it('carries an isolation in the refusal’s own words and the order taken', () => {
    const md = renderLedger({
      window: 'w1',
      base: { branch: 'main', sha: 'b'.repeat(40) },
      thresholds: { size: 5, minutes: 90, source: 'the train config' },
      declarations: '.forge/verify-queue.json at bbb',
      openBranches: [],
      members: [
        { ...member, admission: 'admitted', landing: 'c'.repeat(40), isolated: null, refusals: [] },
        {
          ...member,
          issue: 'ISS-2',
          admission: 'admitted',
          landing: null,
          refusals: [],
          isolated: { kind: 'assembly', because: 'ISS-2 conflicts on src/a.txt' },
        },
      ],
      chain: { head: 'c'.repeat(40), landed: 1 },
    });
    expect(md).toMatch(/\| 1 \| ISS-1 \|.*\| `cccccccccccc` \|/);
    expect(md).toMatch(/\| 2 \| ISS-2 \|.*\| isolated \|/);
    expect(md).toContain('- ISS-2 isolated (assembly): ISS-2 conflicts on src/a.txt');
    expect(md).toContain('size 5, minutes 90, read from the train config');
  });
});
