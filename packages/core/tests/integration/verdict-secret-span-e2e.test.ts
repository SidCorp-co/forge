/**
 * ISS-614 (FB-204): over the verdict route, a reason citing a record id such as task-<24 hex> is
 * written; a real-shaped credential is still refused VERDICT_SECRET, and the refusal names the span
 * it read (offset, length, the public scheme) without sending the credential back.
 *
 * ISS-572: a count after a credential label is prose, also where it closes a sentence or a bracket,
 * and a short secret in a bracket is still refused, telling a writer of prose to reword.
 *
 * @direct-test-of packages/core/src/issues/criteria/verdict-input.ts
 * @direct-test-of packages/observability/src/index.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { type ApiResponse, api, patToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';

const SHA = 'e65b54a38943ea78135b2e1c61fab9dfa5881c8e';
// built here so no tracked file carries a whole key-shaped literal
const KEY_BODY = 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv'.repeat(2);

let projectId: string;
let ownerId: string;
let token: string;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  const agent = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, agent, 'admin');
  token = await patToken(agent, [projectId]);
});

async function issueWithCriterion(): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${projectId}, 1, 'verdict reasons', 'in_progress', ${ownerId})
  `);
  const criteria = await api(token, 'PATCH', `/api/issues/${id}`, {
    acceptanceCriteria: '1. A reminder reaches the nurse.',
  });
  expect(criteria.status, JSON.stringify(criteria.body)).toBe(200);
  return id;
}

const verdict = (id: string, reason: string) =>
  api(token, 'POST', `/api/issues/${id}/verdicts`, {
    criterion: 1,
    verdict: 'fail',
    reason,
    identity: { kind: 'commit', sha: SHA },
  });

async function verdictsOn(id: string): Promise<number> {
  const [row] = await rows<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM criterion_verdicts WHERE issue_id = ${id}`,
  );
  return row?.n ?? -1;
}

function refusalOf(res: ApiResponse): { code: string; path: string; detail: string } | undefined {
  return (res.body.error as { refusals?: { code: string; path: string; detail: string }[] })
    ?.refusals?.[0];
}

describe('a verdict reason over the verdict route', () => {
  it.each([
    'the reminder for task-0b4523e70795a679f6ca7c3d never reached the nurse',
    'desk-0b4523e70795a679f6ca7c3d and risk-7dc311765850e2253a54cb1b were both read',
    'the record tasksk-0b4523e70795a679f6ca7c3d0123456789abcdef was read',
  ])('writes a reason citing record ids: %s', async (reason) => {
    const id = await issueWithCriterion();
    const res = await verdict(id, reason);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await verdictsOn(id)).toBe(1);
  });

  it.each([
    ['a project key', `sk-proj-${KEY_BODY}`, 'sk-proj-***'],
    ['a legacy key', `sk-${KEY_BODY.slice(0, 48)}`, 'sk-***'],
    ['an Anthropic key', `sk-ant-api03-${KEY_BODY}`, 'sk-ant-***'],
    ['a GitHub token', `ghp_${KEY_BODY.slice(0, 36)}`, 'ghp_***'],
  ])('refuses %s, naming its span and not the key', async (_name, key, masked) => {
    const id = await issueWithCriterion();
    const reason = `the log showed ${key} in a header`;
    const res = await verdict(id, reason);
    expect(res.status).toBe(422);
    const refusal = refusalOf(res);
    expect(refusal).toMatchObject({ code: 'VERDICT_SECRET', path: '/reason' });
    expect(refusal?.detail).toContain(
      `at offset 15, ${key.length} characters: \`${masked}\` after \` log showed \``,
    );
    expect(JSON.stringify(res.body)).not.toContain(KEY_BODY.slice(0, 12));
    expect(await verdictsOn(id)).toBe(0);
  });

  it.each([
    'Three runs ended with no token: 4.',
    'The suite ran (no token: 4) and passed.',
    'no token: 4 failures, 3 tests failed, token: 2 left',
  ])('writes a reason counting after a credential label: %s', async (reason) => {
    const id = await issueWithCriterion();
    const res = await verdict(id, reason);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await verdictsOn(id)).toBe(1);
  });

  it('refuses a short secret closing a bracket, without the value, telling prose to reword', async () => {
    const id = await issueWithCriterion();
    const res = await verdict(id, 'the seed logs (password: hunter2).');
    expect(res.status).toBe(422);
    const refusal = refusalOf(res);
    expect(refusal).toMatchObject({ code: 'VERDICT_SECRET', path: '/reason' });
    expect(refusal?.detail).toMatch(/If it is not a secret, reword it\.$/);
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(await verdictsOn(id)).toBe(0);
  });

  it('refuses a key glued to the word before it, showing where the read began', async () => {
    const id = await issueWithCriterion();
    const res = await verdict(id, `leaked apikeysk-${KEY_BODY}`);
    expect(res.status).toBe(422);
    expect(refusalOf(res)?.detail).toContain(
      'a provider key at offset 13, 67 characters: `sk-***` after `eaked apikey`',
    );
    expect(await verdictsOn(id)).toBe(0);
  });
});
