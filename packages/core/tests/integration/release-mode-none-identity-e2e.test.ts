/**
 * Under release mode `none` only a verdict whose identity is the commit the landing records earns a
 * criterion, at the record door and in a requirement's coverage alike. Planted from adminhub-api
 * ISS-10..16 on 2026-10-22: QA judged each criterion with a runtime identity whose ref was the whole
 * landed sha, the record door closed the issues on them, and coverage read the same verdicts as not
 * judged, so REQ-1 read 0/6. The two doors read one verdict two ways.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../helpers/api.js';
import { agreedRequirement, bcOf, traced } from '../helpers/landed-requirement.js';
import {
  F4,
  judgedAll,
  landedIssue,
  ok,
  record,
  refusalsOf,
  seedLandedWorld,
  statusOf,
  world,
} from '../helpers/landed-world.js';

vi.mock('../../src/release-batch/shipped-earlier.js', async (importOriginal) => {
  const { reader } = await import('../helpers/landed-history.js');
  return {
    ...(await importOriginal<typeof import('../../src/release-batch/shipped-earlier.js')>()),
    ancestrySourceFor: async () => ({ kind: 'box', why: 'the planted box', reader }),
  };
});

// adminhub-api's own policy: its issues owe no verdict at the landing, so QA may judge after it
beforeEach(() => seedLandedWorld({ verdictsRequired: false }));

/** QA's verdict on criterion `n` through the verdict route, as the master's QA writes it. */
const judged = (issueId: string, n: number, identity: Record<string, string>) =>
  api(world.token, 'POST', `/api/issues/${issueId}/verdicts`, {
    criterion: n,
    verdict: 'pass',
    reason: `Ran it on the box at ${F4.slice(0, 7)}.`,
    identity,
  });

describe('a runtime identity naming the landed sha', () => {
  it('is refused by the record door by name, as adminhub-api ISS-11 was not', async () => {
    const issue = await landedIssue(11, F4);
    for (const n of [1, 2, 3]) await ok(judged(issue, n, { kind: 'runtime', ref: F4 }));

    const res = await record([issue], F4);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const refusals = refusalsOf(res.body);
    expect(refusals.map((r) => r.code)).toEqual([
      'RELEASE_LANDING_UNJUDGED',
      'RELEASE_LANDING_UNJUDGED',
      'RELEASE_LANDING_UNJUDGED',
    ]);
    expect(refusals[0]?.detail).toContain('ISS-11 criterion 1');
    expect(refusals[0]?.detail).toContain(
      `it was judged against runtime \`${F4}\`, not a commit: with no production environment only a verdict whose identity is the commit its landing records counts`,
    );
    expect(refusals[0]?.detail).toContain(
      `it needs a verdict whose identity is commit \`${F4.slice(0, 12)}\``,
    );
    expect(await statusOf(issue)).toBe('awaiting_release');
  });

  it('is not counted by coverage either, naming the same rule', async () => {
    const req = await agreedRequirement();
    const issue = await landedIssue(11, F4);
    await traced(req, issue, 11);
    await ok(judged(issue, 1, { kind: 'runtime', ref: F4 }));

    const bc = await bcOf(req);

    expect(bc.verdict).toBe('not_judged');
    expect(bc.issues[0]?.notCounted).toBe(
      `judged against runtime \`${F4}\`, not a commit: with no production environment only a verdict whose identity is the commit its landing records counts`,
    );
  });
});

describe('where none is owed', () => {
  it('still closes an issue with no verdict, which QA may judge after the landing', async () => {
    const issue = await landedIssue(11, F4);

    expect((await record([issue], F4)).status).toBe(201);
  });
});

describe('where verdicts are owed', () => {
  it('refuses the same runtime identity by the same sentence', async () => {
    await seedLandedWorld();
    const issue = await landedIssue(11, F4);
    for (const n of [1, 2, 3]) await ok(judged(issue, n, { kind: 'runtime', ref: F4 }));

    const refusals = refusalsOf((await record([issue], F4)).body);

    expect(refusals[0]?.detail).toContain(
      `ISS-11 criterion 1: it was judged against runtime \`${F4}\`, not a commit: with no production environment only a verdict whose identity is the commit its landing records counts; it needs a \`pass\` whose identity is commit \`${F4.slice(0, 12)}\``,
    );
  });
});

describe('a closed issue', () => {
  it('takes a verdict re-written as commit identity at its recorded sha, which coverage then counts', async () => {
    const req = await agreedRequirement();
    const issue = await landedIssue(11, F4);
    await traced(req, issue, 11);
    await judgedAll(issue, F4);
    expect((await record([issue], F4)).status).toBe(201);
    expect(await statusOf(issue)).toBe('closed');

    const res = await judged(issue, 1, { kind: 'commit', sha: F4 });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await bcOf(req)).toMatchObject({ verdict: 'passing' });
  });
});
