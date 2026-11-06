/**
 * ISS-615 (FB-205): a verdict's `evidence` is a list of strings, each at most 500 characters, the list
 * at most 50 items. A judge sent it as one string and read the refusal as a 50-character cap per
 * item, which rules out citing the URL a design verdict rests on (about 140 characters). Through the
 * app's own verdict door, against real Postgres.
 *
 * @direct-test-of packages/contracts/src/verdict-identity.ts
 * @direct-test-of packages/core/src/issues/criteria/input-schemas.ts
 */

import {
  VERDICT_EVIDENCE_ITEM_MAX,
  VERDICT_EVIDENCE_ITEMS_MAX,
} from '@forge/contracts/verdict-identity';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, userToken } from '../helpers/api.js';
import type { Doc } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestIssue,
  createTestProject,
  createTestUser,
} from '../helpers/factories.js';
import { plantLiveBuild } from '../helpers/live-build.js';

const LIVE = '0d91ae7c74f70295ede115463b17559e650b5207';

let token = '';
let issueId = '';

beforeAll(async () => {
  const ownerId = (await createTestUser({ verified: true })).id;
  const projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, ownerId, 'admin');
  token = await userToken(ownerId);
  plantLiveBuild(LIVE);
  issueId = (await createTestIssue(projectId, ownerId, 1, { status: 'in_progress', createdAt: new Date() })).id;
  const put = await api(token, 'PUT', `/api/issues/${issueId}/criteria`, {
    criteria: [{ statement: 'The design read shows every step' }],
  });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
}, 120_000);

const verdict = (evidence: unknown) =>
  api(token, 'POST', `/api/issues/${issueId}/verdicts`, {
    criterion: 1,
    verdict: 'pass',
    reason: 'the steps view lists every step of revision 3',
    identity: { kind: 'commit', sha: LIVE },
    evidence,
  });

/** Everything the refusal says: its sentence and every row. */
const said = (res: { body: unknown }): string => JSON.stringify((res.body as Doc).error ?? res.body);

// the design read FB-205 could not cite, as long as a judge's real one
const DESIGN_READ = `https://forge.example.test/api/projects/${'d1bb4907-74d9-4228-85ff-76121523af7d'}/workflows/${'0f6c1f8e-2b7a-4d39-9a51-3c4a8e2f1b77'}/design?view=steps&revision=3`;

describe('ISS-615 verdict evidence is a list of strings, 500 characters each, 50 at most', () => {
  it('refuses evidence sent as one string, saying it is a list, never naming a character cap on the list', async () => {
    const res = await verdict(DESIGN_READ);

    expect(res.status).toBe(400);
    const text = said(res);
    expect(text).toContain('`evidence` is a list of strings, never one string');
    expect(text).toContain(`each at most ${VERDICT_EVIDENCE_ITEM_MAX} characters`);
    expect(text).toContain(`at most ${VERDICT_EVIDENCE_ITEMS_MAX} items`);
    expect(text).not.toMatch(/<=\s*50 characters|50[- ]character/);
  });

  it('accepts a URL item of at least 140 characters', async () => {
    expect(DESIGN_READ.length).toBeGreaterThanOrEqual(140);

    const res = await verdict([DESIGN_READ]);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it('accepts an item of exactly 500 characters and refuses one of 501, naming the per-item cap', async () => {
    const at = `https://forge.example.test/${'a'.repeat(VERDICT_EVIDENCE_ITEM_MAX - 27)}`;
    expect(at.length).toBe(VERDICT_EVIDENCE_ITEM_MAX);
    expect((await verdict([at])).status).toBeLessThan(300);

    const over = await verdict([`${at}b`]);

    expect(over.status).toBe(400);
    expect(said(over)).toContain(
      `an evidence item is at most ${VERDICT_EVIDENCE_ITEM_MAX} characters`,
    );
  });

  it('accepts 50 items and refuses 51, naming the cap as items, not characters', async () => {
    const fifty = Array.from({ length: VERDICT_EVIDENCE_ITEMS_MAX }, (_, i) => `shot-${i}.png`);
    expect((await verdict(fifty)).status).toBeLessThan(300);

    const over = await verdict([...fifty, 'one-more.png']);

    expect(over.status).toBe(400);
    const text = said(over);
    expect(text).toContain(`\`evidence\` holds at most ${VERDICT_EVIDENCE_ITEMS_MAX} items`);
    expect(text).not.toMatch(/<=\s*50 characters|50[- ]character/);
  });
});
