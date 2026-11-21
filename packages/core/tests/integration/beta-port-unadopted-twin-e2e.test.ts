/**
 * ISS-1387: sidpeak's dev issues ISS-21..39 closed and live while their beta twins stood at
 * Awaiting release or Open, and the fire named none of them. The twin is a dev issue whose first line
 * names the beta issue, but the pair was recorded only after the in-flight and before-the-ruling
 * gates, which pass such a beta issue over silently, so the mirror never saw it. Here: a beta issue
 * filed before the ruling and standing at `awaiting_release` or `open`, named by a closed dev twin,
 * is adopted and then mirrored closed or refused by name; one whose twin is still building is
 * adopted, and beta is not moved. forge-beta is the stub HTTP server of `beta-port-world.ts`.
 *
 * @direct-test-of packages/core/src/beta-port/run.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  betaPortScheduleOn,
  fireOnce,
  putBetaSecret,
  type Say,
} from '../helpers/beta-port-harness.js';
import {
  beforeRuling,
  beta,
  betaIssue,
  outsideGitDocument,
  RULING_AT,
  startBeta,
  stopBeta,
  TOKEN,
  writeRuling,
} from '../helpers/beta-port-world.js';
import { closeWorld, requester, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser } from '../helpers/factories.js';

let say: Say;
let twin = { id: '', slug: '' };
let betaProjectId = '';
let scheduleId = '';

beforeAll(async () => {
  testEnv();
  const baseUrl = await startBeta();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const ownerId = (await createTestUser({ verified: true })).id;
  const scheduleProjectId = (await createTestProject(ownerId)).id;
  const t = await createTestProject(ownerId);
  twin = { id: t.id, slug: t.slug };
  say = requester(app, { owner: await signUserToken(ownerId) }) as Say;
  betaProjectId = randomUUID();
  beta.projects = [{ id: betaProjectId, slug: twin.slug }];
  beta.configs.set(betaProjectId, outsideGitDocument());
  beta.issues.set(betaProjectId, []);
  scheduleId = await betaPortScheduleOn(say, scheduleProjectId);
  await putBetaSecret(say, scheduleProjectId, 'forge-beta-url', baseUrl);
  await putBetaSecret(say, scheduleProjectId, 'forge-beta-token', TOKEN);
  await writeRuling(scheduleProjectId, RULING_AT);
}, 120_000);

afterAll(async () => {
  await stopBeta();
  await closeWorld();
});

/** A dev issue whose first line names the beta issue, with no pair recorded: a port done by hand. */
async function handTwin(b: { id: string; displayId: string; title: string }, status: string) {
  const created = await say('owner', 'POST', `/api/projects/${twin.id}/issues`, {
    title: b.title,
    description: `Ported from forge-beta ${b.displayId} (${b.id}).`,
    status: 'draft',
  });
  expect(created.status).toBe(201);
  const id = (created.json as { id: string }).id;
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  const { db } = await import('../../src/db/client.js');
  const landed =
    status === 'closed'
      ? sql`, merged_at = now(), merged_landing = 'https://dev.example/landed'`
      : sql``;
  await withKernelMarker(db, (tx) =>
    tx.execute(sql`UPDATE issues SET status = ${status}${landed} WHERE id = ${id}`),
  );
  return id;
}

describe('a beta issue named by its dev twin is mirrored whatever its status or age (ISS-1387)', () => {
  it('names each closed twin on its first fire, mirrored or refused, and leaves a building one', async () => {
    const landed = betaIssue(628, { status: 'awaiting_release', createdAt: beforeRuling() });
    const open = betaIssue(639, { status: 'open', createdAt: beforeRuling() });
    const building = betaIssue(645, { status: 'awaiting_release', createdAt: beforeRuling() });
    beta.issues.get(betaProjectId)?.push(landed, open, building);
    await handTwin(landed, 'closed');
    await handTwin(open, 'closed');
    await handTwin(building, 'in_progress');
    const settled = await fireOnce(say, scheduleId);
    const out = settled.output ?? '';
    for (const b of [landed, open]) {
      expect(out, out).toMatch(new RegExp(`(beta ${b.displayId}\\)|beta ${b.displayId} closed:)`));
    }
    expect(out).toContain('ISS-628 (named on ');
    expect(out).toContain('ISS-639 (named on ');
    // the building twin is adopted and beta holds its status: it is named, never moved
    expect(out).toContain('ISS-645 (named on ');
    expect(out).not.toMatch(/\(beta ISS-645\)$/m);
  });
});
