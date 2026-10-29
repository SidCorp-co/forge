/**
 * A requirement's status moves only by an explicit act (REQ-74 BC-8): agreed → in_delivery →
 * delivered is a move a person, the assistant or an agent makes through one door, and no read infers
 * it from results. A move whose condition is not met is refused naming each missing condition (BC-9):
 * in delivery asks for a linked issue, delivered for a pass on the running build on every live
 * criterion (BC-10).
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { api } from '../helpers/api.js';
import { addProjectMember, createTestUser, rows } from '../helpers/factories.js';
import { agreedRequirement, requirementRead, traced } from '../helpers/landed-requirement.js';
import {
  F4,
  LATER,
  landedIssue,
  laterLanding,
  seedLandedWorld,
  verdict,
  world,
} from '../helpers/landed-world.js';

vi.mock('../../src/release-batch/ancestry-source.js', async (importOriginal) => {
  const { reader } = await import('../helpers/landed-history.js');
  return {
    ...(await importOriginal<typeof import('../../src/release-batch/ancestry-source.js')>()),
    ancestrySourceFor: async () => ({ kind: 'box', why: 'the planted box', reader }),
  };
});

type Refusal = { code: string; path: string; detail: string };
type Answer = { status: number; body: Record<string, unknown> };

const refusalsOf = (r: Answer): Refusal[] =>
  (r.body.error as { refusals?: Refusal[] } | undefined)?.refusals ?? [];

let agent = '';

beforeEach(async () => {
  await seedLandedWorld();
  const id = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(world.projectId, id, 'member');
  agent = (
    await mintPat({ permissions: ['*'], userId: id, name: 'master', projectIds: [world.projectId] })
  ).plaintext;
});

const move = (req: string, act: 'start-delivery' | 'mark-delivered', token = agent) =>
  api(token, 'POST', `/api/projects/${world.projectId}/requirements/${req}/${act}`, {
    reason: 'moved by the run that built it',
  });

/** The requirement with ISS-`seq` traced to each of `codes`, criterion n to the nth code. */
async function withIssue(req: string, seq: number, codes: string[]): Promise<string> {
  const issue = await landedIssue(seq, F4);
  await traced(req, issue, seq, Object.fromEntries(codes.map((c, i) => [i + 1, c])));
  return issue;
}

const storedStatus = async (req: string) =>
  (
    await rows<{ status: string }>(sql`
      SELECT status FROM requirements WHERE project_id = ${world.projectId} AND req_seq = ${Number(req.slice(4))}`)
  )[0]?.status;

describe('a requirement whose every criterion passes', () => {
  it('stays agreed on read until it is moved, then moves by an agent token one step at a time', async () => {
    const req = await agreedRequirement(['A site lists its catalog']);
    const issue = await withIssue(req, 1, ['BC-1', 'BC-1', 'BC-1']);
    for (const n of [1, 2, 3]) await verdict(issue, n, 'pass', LATER);
    // a landing recorded at LATER is what says it holds the issue's landing
    await laterLanding(LATER);

    const before = await requirementRead(req);
    expect(before.standing.coverage.map((c) => c.verdict)).toEqual(['passing']);
    // the results say delivered; nothing moved it, so it reads agreed
    expect((before as unknown as { status: string }).status).toBe('agreed');
    expect((before.standing as unknown as { state: string }).state).toBe('agreed');
    expect(before.standing.delivery).not.toHaveProperty('phase');
    expect(await storedStatus(req)).toBe('agreed');

    // agreed → delivered is no edge: it is moved into delivery first
    const skipped = await move(req, 'mark-delivered');
    expect(skipped.status, JSON.stringify(skipped.body)).toBe(422);
    expect(refusalsOf(skipped).map((x) => x.code)).toEqual(['TRANSITION_NOT_AN_EDGE']);

    const started = await move(req, 'start-delivery');
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(await storedStatus(req)).toBe('in_delivery');

    const delivered = await move(req, 'mark-delivered');
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
    expect(await storedStatus(req)).toBe('delivered');
    const after = await requirementRead(req);
    expect((after.standing as unknown as { state: string }).state).toBe('delivered');

    const moves = await rows<{ from_status: string; to_status: string; actor_agency: string }>(sql`
      SELECT from_status, to_status, actor_agency FROM kernel_transitions
       WHERE entity = 'requirement'
         AND entity_id = (SELECT id FROM requirements WHERE project_id = ${world.projectId}
                                                          AND req_seq = ${Number(req.slice(4))})
         AND to_status IN ('in_delivery', 'delivered')
       ORDER BY created_at`);
    expect(moves).toEqual([
      { from_status: 'agreed', to_status: 'in_delivery', actor_agency: 'agent' },
      { from_status: 'in_delivery', to_status: 'delivered', actor_agency: 'agent' },
    ]);
  });
});

describe('a move whose condition is not met', () => {
  it('refuses in delivery with no linked issue, by name', async () => {
    const req = await agreedRequirement(['A site lists its catalog']);
    const r = await move(req, 'start-delivery');
    expect(r.status).toBe(422);
    expect(refusalsOf(r).map((x) => x.code)).toEqual(['REQUIREMENT_NO_LIVE_ISSUE']);
    expect(await storedStatus(req)).toBe('agreed');
  });

  it('refuses delivered naming the one criterion with no pass on the running build', async () => {
    const req = await agreedRequirement(['A site lists its catalog', 'A search narrows the list']);
    const issue = await withIssue(req, 1, ['BC-1', 'BC-1', 'BC-2']);
    await verdict(issue, 1, 'pass', F4);
    await verdict(issue, 2, 'pass', F4);
    await verdict(issue, 3, 'fail', F4);
    expect((await move(req, 'start-delivery')).status).toBe(200);

    const r = await move(req, 'mark-delivered');
    expect(r.status).toBe(422);
    const [refusal, ...more] = refusalsOf(r);
    expect(more).toEqual([]);
    expect(refusal?.code).toBe('REQUIREMENT_CRITERIA_UNPROVEN');
    expect(refusal?.detail).toContain('BC-2');
    expect(refusal?.detail).not.toContain('BC-1');
    expect(await storedStatus(req)).toBe('in_delivery');
  });
});
