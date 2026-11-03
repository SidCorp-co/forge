/**
 * ISS-923 backfill: the beta port's first fire read issue bodies from beta's list, which carries none,
 * so each dev issue it made holds only its provenance line. A fire now writes the beta body under
 * that line, once per pair, through the issue update and as the twin's owner acting as an agent; a
 * description that is anything else is never touched; an empty beta body is recorded and named; a
 * refused beta read is reported and retried; the report names each pair with its twin; the bound
 * names what it leaves; and the "never twice" guard still reads the first line after a backfill.
 * forge-beta is a stub HTTP server this file starts and stops. Against real Postgres.
 *
 * @direct-test-of packages/core/src/beta-port/backfill.ts
 * @direct-test-of packages/core/src/beta-port/report.ts
 * @direct-test-of packages/core/src/beta-port/markers.ts
 * @direct-test-of packages/core/src/beta-port/store.ts
 * @direct-test-of packages/core/src/beta-port/run.ts
 * @direct-test-of packages/core/src/issues/update-service.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  betaPortScheduleOn,
  devIssuesOf,
  fireOnce,
  putBetaSecret,
  type Say,
} from '../helpers/beta-port-harness.js';
import {
  beta,
  betaIssue,
  RULING_AT,
  type StubIssue,
  startBeta,
  stopBeta,
  TOKEN,
  writeRuling,
} from '../helpers/beta-port-world.js';
import { closeWorld, ok, requester, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, rows } from '../helpers/factories.js';

let say: Say;
let ownerId = '';
let twin = { id: '', slug: '' };
let betaProjectId = '';
let scheduleId = '';

beforeAll(async () => {
  testEnv();
  const baseUrl = await startBeta();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  const scheduleProjectId = (await createTestProject(ownerId)).id;
  const t = await createTestProject(ownerId);
  twin = { id: t.id, slug: t.slug };
  say = requester(app, { owner: await signUserToken(ownerId) }) as Say;
  betaProjectId = randomUUID();
  beta.projects = [{ id: betaProjectId, slug: twin.slug }];
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

const fire = (id: string) => fireOnce(say, id);
const devIssues = () => devIssuesOf(twin.id);

/** A pair as the first fire left it: its dev issue holds only the provenance line, and no backfill. */
async function stubPort(
  source: StubIssue,
  project: { id: string; slug: string },
  description = `Ported from forge-beta ${source.displayId} (${source.id}).`,
): Promise<{ id: string; key: string }> {
  const created = ok(
    await say('owner', 'POST', `/api/projects/${project.id}/issues`, {
      title: source.title,
      description: 'placeholder',
      status: 'draft',
    }),
    201,
  );
  const id = created.id as string;
  await rows(sql`UPDATE issues SET description = ${description} WHERE id = ${id}`);
  await rows(
    sql`INSERT INTO beta_port_pairs (beta_issue_id, beta_key, beta_project_slug, dev_issue_id, last_mirrored_status, last_tried_status, beta_reached)
        VALUES (${source.id}, ${source.displayId}, ${project.slug}, ${id}, NULL, 'draft', ${source.status})`,
  );
  const [dev] = await rows<{ iss_seq: number }>(sql`SELECT iss_seq FROM issues WHERE id = ${id}`);
  return { id, key: `ISS-${dev?.iss_seq}` };
}

const descriptionOf = async (id: string) =>
  (
    await rows<{ description: string | null }>(sql`SELECT description FROM issues WHERE id = ${id}`)
  )[0]?.description;

const backfillOf = async (betaId: string) =>
  (
    await rows<{ body_backfilled_at: Date | null; body_backfill_fire_id: string | null }>(
      sql`SELECT body_backfilled_at, body_backfill_fire_id FROM beta_port_pairs WHERE beta_issue_id = ${betaId}`,
    )
  )[0];

const stubLine = (b: StubIssue) => `Ported from forge-beta ${b.displayId} (${b.id}).`;

describe('a beta port backfill (ISS-923)', () => {
  const stubbed = betaIssue(30, { description: 'What beta issue 30 asks for.\n\n- step one\n' });
  const edited = betaIssue(31);
  const oneLine = betaIssue(32);
  const empty = betaIssue(33, { description: null });
  const unread = betaIssue(34);
  const dev = new Map<string, { id: string; key: string }>();

  it('(a)(b)(c)(d) a stub gets the beta body under its first line once, an edit is left, an empty body is named, a refused read is retried', async () => {
    beta.issues.get(betaProjectId)?.push(stubbed, edited, oneLine, empty, unread);
    dev.set(stubbed.id, await stubPort(stubbed, twin, `${stubLine(stubbed)}  \n`));
    dev.set(
      edited.id,
      await stubPort(edited, twin, `${stubLine(edited)}\n\nA master's own notes.`),
    );
    dev.set(oneLine.id, await stubPort(oneLine, twin, `${stubLine(oneLine)} Read on site.`));
    dev.set(empty.id, await stubPort(empty, twin));
    dev.set(unread.id, await stubPort(unread, twin));
    const keyOf = (b: StubIssue) => dev.get(b.id)?.key as string;
    const idOf = (b: StubIssue) => dev.get(b.id)?.id as string;
    const issuesBefore = (await devIssues()).length;
    beta.refuseRead.set(unread.id, 'BETA_DOWN_FOR_A_MOMENT');

    const first = await fire(scheduleId);
    expect(first.status, JSON.stringify(first)).toBe('success');
    // (a) the provenance line first, then a blank line, then the beta body
    expect(await descriptionOf(idOf(stubbed))).toBe(
      `${stubLine(stubbed)}\n\nWhat beta issue 30 asks for.\n\n- step one`,
    );
    expect(await backfillOf(stubbed.id)).toMatchObject({ body_backfill_fire_id: first.id });
    expect((await backfillOf(stubbed.id))?.body_backfilled_at).not.toBeNull();
    // (d) the report names the pair with its twin
    expect(first.output).toContain(
      `backfilled (1):\n  ${twin.slug}: ${keyOf(stubbed)} ← beta ISS-30`,
    );
    // written through the issue update, as the twin's owner acting as an agent
    let activity: { actor_id: string; actor_agency: string }[] = [];
    for (let i = 0; i < 100 && activity.length === 0; i += 1) {
      activity = await rows(
        sql`SELECT actor_id, actor_agency FROM activity_log WHERE issue_id = ${idOf(stubbed)} AND action = 'issue.updated'`,
      );
      if (activity.length === 0) await new Promise((r) => setTimeout(r, 50));
    }
    expect(activity).toEqual([{ actor_id: ownerId, actor_agency: 'agent' }]);
    // (b) a description that is anything but the stub is never touched
    expect(await descriptionOf(idOf(edited))).toBe(`${stubLine(edited)}\n\nA master's own notes.`);
    expect(await descriptionOf(idOf(oneLine))).toBe(`${stubLine(oneLine)} Read on site.`);
    for (const b of [edited, oneLine]) {
      expect((await backfillOf(b.id))?.body_backfilled_at).toBeNull();
      expect(first.output).not.toContain(`${keyOf(b)} ← beta`);
    }
    // (c) an empty beta body is recorded and named, and nothing is written
    expect(first.output).toContain(
      `backfilled with no beta body to write (1):\n  ${twin.slug}: ${keyOf(empty)} ← beta ISS-33`,
    );
    expect(await descriptionOf(idOf(empty))).toBe(stubLine(empty));
    expect((await backfillOf(empty.id))?.body_backfilled_at).not.toBeNull();
    // (c) a refused beta read is reported with its code and left for the next fire
    expect(first.output).toContain(
      `${twin.slug}: ${keyOf(unread)} ← beta ISS-34 body: BETA_DOWN_FOR_A_MOMENT`,
    );
    expect(first.output).toContain('tried again next fire');
    expect(await descriptionOf(idOf(unread))).toBe(stubLine(unread));
    expect((await backfillOf(unread.id))?.body_backfilled_at).toBeNull();

    // the next fire: beta answers the read it refused, and changes the body already written
    beta.refuseRead.delete(unread.id);
    stubbed.description = 'A later beta edit, never carried.';
    const second = await fire(scheduleId);
    expect(await descriptionOf(idOf(unread))).toBe(
      `${stubLine(unread)}\n\nWhat beta issue 34 asks for.`,
    );
    expect(second.output).toContain(
      `backfilled (1):\n  ${twin.slug}: ${keyOf(unread)} ← beta ISS-34`,
    );
    expect(await descriptionOf(idOf(stubbed))).toBe(
      `${stubLine(stubbed)}\n\nWhat beta issue 30 asks for.\n\n- step one`,
    );
    for (const b of [stubbed, empty]) expect(second.output).not.toContain(`${keyOf(b)} ← beta`);

    // a third fire owes no backfill and says none
    const third = await fire(scheduleId);
    expect(third.output).not.toContain('backfilled');
    expect(await devIssues()).toHaveLength(issuesBefore);
  });

  it('(e) the "never twice" guard holds after a backfill: the first line still names the beta issue, and nothing is ported again', async () => {
    const { id, key } = dev.get(stubbed.id) as { id: string; key: string };
    const written = (await descriptionOf(id)) as string;
    expect(written.split('\n')[0]).toBe(stubLine(stubbed));
    // without its pair, only the first line can tell the port this beta issue is ported
    await rows(sql`DELETE FROM beta_port_pairs WHERE beta_issue_id = ${stubbed.id}`);
    const issuesBefore = (await devIssues()).length;
    const commentsBefore = beta.comments.get(stubbed.id) ?? [];
    const settled = await fire(scheduleId);
    expect(await devIssues()).toHaveLength(issuesBefore);
    expect(settled.output).toContain(`ISS-30 (named on ${key})`);
    expect(settled.output).not.toContain('beta ISS-30 →');
    expect(beta.comments.get(stubbed.id) ?? []).toEqual(commentsBefore);
    // re-adopted, and its body is no stub: it is left as written
    expect(await descriptionOf(id)).toBe(written);
    expect(settled.output).not.toContain('backfilled');
  });

  it('(d) the per-fire backfill bound names each pair it leaves, and the next fire backfills it', async () => {
    const cap = await createTestProject(ownerId);
    const stubs = Array.from({ length: 26 }, (_, i) => betaIssue(300 + i));
    // a beta project this fire does not list: only the backfill reads these issues
    beta.issues.set(randomUUID(), stubs);
    const devOf = new Map<string, { id: string; key: string }>();
    for (const b of stubs) devOf.set(b.id, await stubPort(b, { id: cap.id, slug: cap.slug }));

    const first = await fire(scheduleId);
    const still = [];
    for (const b of stubs) {
      if ((await descriptionOf(devOf.get(b.id)?.id as string)) === stubLine(b)) still.push(b);
    }
    expect(still).toHaveLength(1);
    const left = still[0] as StubIssue;
    expect(first.output).toContain('backfilled (25):');
    expect(first.output).toContain(
      `bodies owed to the next fire (1):\n  ${cap.slug}: ${devOf.get(left.id)?.key} ← beta ${left.displayId}`,
    );
    const next = await fire(scheduleId);
    expect(next.output).toContain(
      `backfilled (1):\n  ${cap.slug}: ${devOf.get(left.id)?.key} ← beta ${left.displayId}`,
    );
    expect(next.output).not.toContain('bodies owed');
  }, 60_000);
});
