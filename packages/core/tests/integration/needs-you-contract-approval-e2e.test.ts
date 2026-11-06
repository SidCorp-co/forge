/**
 * ISS-1055: a proposed contract version reaches its approver's Needs you as a decision, and the
 * workspace's Activity counts it under `you`. The planted shape is the one seen on catalog-api: one
 * version approved, eight later ones proposed with no decision; the held interface publishes the
 * slug, the membership is active, and the reader holds `contracts.approve`. Before the fix the act
 * `contracts.act.approveOrReturn` was in no table of acts a person decides, so the row was classed
 * as work an agent takes and both counts read 0.
 *
 * @direct-test-of packages/core/src/development/needs-you-decisions.ts
 * @direct-test-of packages/core/src/development/needs-you-approve-builders.ts
 * @direct-test-of packages/core/src/development/needs-you-agent-takes.ts
 * @direct-test-of packages/core/src/ecosystem/standing/read.ts
 * @direct-test-of packages/contracts/src/needs-you-decisions.ts
 * @direct-test-of packages/core/src/ecosystem/contract/decide.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  closeWorld,
  type Doc,
  type EcosystemWorld,
  formEcosystem,
  ok,
  openWorld,
  seedContractVersion,
  sender,
  settleOutbox,
  writeInterfaces,
} from '../helpers/ecosystem-world.js';
import { addProjectMember } from '../helpers/factories.js';

let w: EcosystemWorld;
let send: ReturnType<typeof sender>;

const REF = 'forge/forge-api';
const PROPOSED = ['9.2.0', '9.3.0', '9.4.0', '9.5.0', '9.6.0', '10.0.0', '10.1.0', '11.0.0'];

async function recordedDaysAgo(version: string, days: number): Promise<void> {
  await db.execute(sql`
    UPDATE contract_versions
       SET recorded_at = now() - make_interval(secs => ${days * 86_400})
     WHERE provider_project_id = ${w.project.forge} AND contract_slug = 'forge-api'
       AND version = ${version}`);
}

beforeAll(async () => {
  w = await openWorld();
  send = sender(w);
  await formEcosystem(w);
  await writeInterfaces(w);
  await addProjectMember(w.project.forge, w.user.viewer, 'viewer');
  await recordedDaysAgo('2026-09-20', 20);
  await seedContractVersion({
    providerId: w.project.forge,
    ref: REF,
    version: '9.1.0',
    classification: 'non-breaking',
  });
  await recordedDaysAgo('9.1.0', 10);
  for (const [i, version] of PROPOSED.entries()) {
    await seedContractVersion({
      providerId: w.project.forge,
      ref: REF,
      version,
      classification: version.endsWith('.0.0') ? 'breaking' : 'non-breaking',
      approval: 'proposed',
    });
    await recordedDaysAgo(version, 9 - i);
  }
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

const decisions = async (): Promise<Doc[]> =>
  ok(await send('platform', 'GET', `/api/projects/${w.project.forge}/needs-you/decisions`))
    .decisions as Doc[];

const contractDecisionOf = async (): Promise<Doc | undefined> =>
  (await decisions()).find((d) => d.entity === 'contract' && d.key === REF);

describe('ISS-1055 a proposed contract version is its approver decision', () => {
  it('the newest proposed version is a decision on its approver Needs you, naming the ones behind it', async () => {
    const d = await contractDecisionOf();
    expect(d, 'no contract decision on the approver Needs you').toBeDefined();
    expect(d?.group).toBe('approve');
    expect(d?.opens).toEqual({ kind: 'contract', key: REF });
    expect(d?.question).toContain('11.0.0');
    expect(d?.question).toContain('breaking');
    // the seven behind it: four named, the rest counted
    expect(d?.impact).toContain('10.1.0, 10.0.0, 9.6.0, 9.5.0 and 3 more');
    const acts = ((d?.answers ?? []) as Doc[]).map((a) => [a.id, a.act, a.path, a.body]);
    const path = `/api/projects/${w.project.forge}/contracts/forge-api/versions/11.0.0/decision`;
    expect(acts).toEqual([
      ['approve', 'contract.decide', path, { decision: 'approve' }],
      ['return', 'contract.decide', path, { decision: 'return' }],
    ]);
  });

  it('Activity counts it under you for the approver', async () => {
    const { readOrgActivity, peopleGlances } = await import('../../src/activity/read.js');
    peopleGlances.forget();
    const read = await readOrgActivity(
      w.org.platform,
      { userId: w.user.platform, agency: 'human' },
      new Date(),
      { waitMs: 60_000 },
    );
    const row = read.projects.find((p) => p.projectId === w.project.forge);
    expect(row?.peoplePending).toBe(false);
    expect(row?.people.total, 'Activity does not count the contract decision').toBeGreaterThan(0);
    expect(row?.people.items.map((i) => i.opens)).toContainEqual({ kind: 'contract', key: REF });
    expect(row?.group).toBe('you');
  }, 90_000);

  it('a reader without contracts.approve is not asked', async () => {
    const seen = ok(
      await send('viewer', 'GET', `/api/projects/${w.project.forge}/needs-you/decisions`),
    ).decisions as Doc[];
    expect(seen.some((d) => d.entity === 'contract')).toBe(false);
  });

  it('its return button returns the version and the next proposed one becomes the decision', async () => {
    const d = (await contractDecisionOf()) as Doc;
    const ret = (d.answers as Doc[]).find((a) => a.id === 'return') as Doc;
    ok(
      await send('platform', 'POST', ret.path, {
        ...(ret.body as Doc),
        reason: 'the consumers cannot take this break yet',
      }),
    );
    const next = await contractDecisionOf();
    expect(next?.question).toContain('10.1.0');
    expect(next?.impact).toContain('10.0.0, 9.6.0, 9.5.0, 9.4.0 and 2 more');
  });

  it('its approve button approves it, nothing is left to decide, and Activity hears it at once (ISS-1053)', async () => {
    const { readOrgActivity, peopleGlances } = await import('../../src/activity/read.js');
    const viewer = { userId: w.user.platform, agency: 'human' as const };
    const forgeRow = (read: Awaited<ReturnType<typeof readOrgActivity>>) =>
      read.projects.find((p) => p.projectId === w.project.forge);
    peopleGlances.forget();
    // the glance is read just before the decision, well inside its 30 s
    const warm = await readOrgActivity(w.org.platform, viewer, new Date(), { waitMs: 60_000 });
    expect(forgeRow(warm)?.people.items.map((i) => i.opens)).toContainEqual({
      kind: 'contract',
      key: REF,
    });
    const d = (await contractDecisionOf()) as Doc;
    const approve = (d.answers as Doc[]).find((a) => a.id === 'approve') as Doc;
    const out = ok(await send('platform', 'POST', approve.path, approve.body));
    expect(out.approval?.approval ?? out.version?.approval ?? 'approved').toBe('approved');
    expect(await contractDecisionOf()).toBeUndefined();
    // the decision's own event (decision.settled) marks the held glance stale
    await settleOutbox();
    const next = await readOrgActivity(w.org.platform, viewer, new Date());
    expect(next.refreshing, 'the read after the decision started no refresh').toBe(true);
    const until = Date.now() + 30_000;
    let after = next;
    while (after.refreshing && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 100));
      after = await readOrgActivity(w.org.platform, viewer, new Date());
    }
    expect(forgeRow(after)?.people.items.map((i) => i.opens)).not.toContainEqual({
      kind: 'contract',
      key: REF,
    });
  }, 90_000);
});
