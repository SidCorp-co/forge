/**
 * A requirement on a project whose landing is its delivery is proven by its issues' recorded
 * landings. Planted from catalog-fe REQ-3 on 2026-10-22: ISS-6 and ISS-7 closed by one landing record
 * at one commit and ISS-23 by another, every criterion traced to BC-1..4 and judged pass at its
 * issue's recorded commit, then reopened by the steward before the landing fix shipped and closed by
 * the record. Coverage voided every pass as older than the reopen, so the requirement read
 * `{ criteria: 4, passing: 0, judged: 0 }` while the record that closed the issues counted them: the
 * two read one issue's verdicts by two rules.
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  agreedRequirement,
  bcOf,
  checklistsOf,
  reopenedNow,
  requirementRead,
  traced,
} from '../helpers/landed-requirement.js';
import {
  ASIDE,
  BRANCH,
  D9,
  F4,
  LATER,
  landedIssue,
  record,
  seedLandedWorld,
  statusOf,
  verdict,
} from '../helpers/landed-world.js';

vi.mock('../../src/release-batch/ancestry-source.js', async (importOriginal) => {
  const { reader } = await import('../helpers/landed-history.js');
  return {
    ...(await importOriginal<typeof import('../../src/release-batch/ancestry-source.js')>()),
    ancestrySourceFor: async () => ({ kind: 'box', why: 'the planted box', reader }),
  };
});

const BCS = [
  'A site lists its catalog',
  'A product opens from its row',
  'A search narrows the list',
  'An empty list says so',
];

beforeEach(seedLandedWorld);

async function passedAll(issueId: string, commit: string) {
  for (const n of [1, 2, 3]) await verdict(issueId, n, 'pass', commit);
}

describe('a requirement whose issues all closed by landing records', () => {
  it('reads every BC passing at its issue recorded commit, after a steward reopen', async () => {
    const req = await agreedRequirement(BCS);
    const six = await landedIssue(6, F4);
    const seven = await landedIssue(7, F4);
    const twentyThree = await landedIssue(23, LATER);
    await traced(req, six, 6, { 1: 'BC-1', 2: 'BC-2', 3: 'BC-4' });
    await traced(req, seven, 7, { 1: 'BC-1', 2: 'BC-4', 3: 'BC-1' });
    await traced(req, twentyThree, 23, { 1: 'BC-1', 2: 'BC-2', 3: 'BC-3' });
    await passedAll(six, F4);
    await passedAll(seven, F4);
    await passedAll(twentyThree, LATER);
    for (const id of [six, seven, twentyThree]) await reopenedNow(id);

    expect((await record([six, seven], F4)).status).toBe(201);
    expect((await record([twentyThree], LATER)).status).toBe(201);
    expect(await statusOf(twentyThree)).toBe('closed');

    const read = await requirementRead(req);
    expect(read.standing.delivery.criteriaCoverage).toEqual({ criteria: 4, passing: 4, judged: 4 });
    // proven, and still only an act moves it to delivered (REQ-74 BC-8)
    expect(read.standing.delivery).not.toHaveProperty('phase');
    expect(read.standing.coverage.map((c) => c.verdict)).toEqual([
      'passing',
      'passing',
      'passing',
      'passing',
    ]);
    const landedIn = Object.fromEntries(read.issues.map((i) => [i.displayId, i.landedIn]));
    expect(landedIn).toEqual({
      'ISS-6': { branch: BRANCH, commit: F4, at: expect.any(String) },
      'ISS-7': { branch: BRANCH, commit: F4, at: expect.any(String) },
      'ISS-23': { branch: BRANCH, commit: LATER, at: expect.any(String) },
    });
    // a recorded landing is a release like any other (catalog-api run 9ed968de, 2026-10-26)
    const shippedIn = Object.fromEntries(
      read.issues.map((i) => [i.displayId, (i.shippedIn as { version?: string } | null)?.version]),
    );
    expect(shippedIn).toEqual({ 'ISS-6': '0.1.0', 'ISS-7': '0.1.0', 'ISS-23': '0.2.0' });

    const acceptance = (await checklistsOf(req)).checklists.find((c) => c.id.includes('accept'));
    const said = JSON.stringify(acceptance?.now);
    expect(said).toContain('Every current criterion passes on the running build.');
    expect(said).toContain('All 3 live issues shipped.');
  });

  // catalog-fe REQ-1 ISS-1: marked at 28a99efe, every pass at d94db013, reopened after them, closed
  // by a record at d94db013; ISS-3, re-judged after its reopen, was the only issue that counted
  it('counts passes at the recorded head after a reopen, where the mark names an earlier commit', async () => {
    const req = await agreedRequirement(BCS.slice(0, 1));
    const issue = await landedIssue(1, F4);
    await traced(req, issue, 1);
    await passedAll(issue, LATER);
    await reopenedNow(issue);
    expect((await record([issue], LATER)).status).toBe(201);

    expect(await bcOf(req)).toMatchObject({ verdict: 'passing' });
  });

  it('reads passing before any record where every criterion passes at a later head holding the landing', async () => {
    const req = await agreedRequirement(BCS.slice(0, 1));
    const issue = await landedIssue(1, F4);
    await traced(req, issue, 1);
    await passedAll(issue, LATER);

    expect(await bcOf(req)).toMatchObject({ verdict: 'passing' });
  });

  // adminhub-api ISS-15, 2026-10-26: closed by a landing record, then delivered again through a
  // request the host merged; coverage kept reading the record's commit as its landing
  it('reads a host merge observed after the landing record as the landing, superseding it', async () => {
    const req = await agreedRequirement(BCS.slice(0, 1));
    const issue = await landedIssue(6, F4);
    await traced(req, issue, 6);
    await passedAll(issue, F4);
    expect((await record([issue], F4)).status).toBe(201);
    expect(await bcOf(req)).toMatchObject({ verdict: 'passing' });

    await db.execute(sql`
      UPDATE issues SET merged_commit_sha = ${LATER}, merged_at = now() + interval '1 minute'
       WHERE id = ${issue}`);
    const moved = await bcOf(req);
    expect(moved.verdict).toBe('not_live');
    expect(moved.issues[0]?.notCounted).toContain(
      `judged at commit ${F4.slice(0, 12)}, not at its issue's landing ${LATER.slice(0, 12)}`,
    );

    await passedAll(issue, LATER);
    expect(await bcOf(req)).toMatchObject({ verdict: 'passing' });
  });

  it('reads a fail at the recorded commit as failing, not passing', async () => {
    const req = await agreedRequirement(BCS.slice(0, 1));
    const issue = await landedIssue(6, F4);
    await traced(req, issue, 6);
    await verdict(issue, 1, 'fail', F4);

    expect(await bcOf(req)).toMatchObject({ verdict: 'failing' });
  });

  // catalog-fe REQ-3, 2026-10-26: the pass the reopen voided read as no verdict at all, so the line
  // said nothing of why it did not count
  it('does not count a pass before a reopen at a commit other than the landing, and says which commit it was', async () => {
    const req = await agreedRequirement(BCS.slice(0, 1));
    const issue = await landedIssue(6, F4);
    await traced(req, issue, 6);
    await verdict(issue, 1, 'pass', D9);
    await reopenedNow(issue);

    const bc = await bcOf(req);
    expect(bc.verdict).toBe('not_live');
    expect(bc.issues[0]?.notCounted).toContain(
      `judged at commit ${D9.slice(0, 12)}, not at its issue's landing ${F4.slice(0, 12)}`,
    );
  });

  // adminhub-fe ISS-4, dev.344 (REQ-36 BC-18): a pass on a later build holding the landing is a
  // pass on the delivered work; one at a commit that does not hold it judged another build
  it('counts a pass at a later commit holding the landing, and never one at a commit that does not', async () => {
    const req = await agreedRequirement(BCS.slice(0, 1));
    const issue = await landedIssue(6, F4);
    await traced(req, issue, 6);
    await verdict(issue, 1, 'pass', LATER);

    expect(await bcOf(req)).toMatchObject({ verdict: 'passing' });

    await verdict(issue, 1, 'pass', ASIDE);
    const bc = await bcOf(req);
    expect(bc.verdict).toBe('not_live');
    expect(bc.issues[0]?.notCounted).toContain(
      `judged at commit ${ASIDE.slice(0, 12)}, not at its issue's landing ${F4.slice(0, 12)} nor at a build that holds it`,
    );
  });
});
