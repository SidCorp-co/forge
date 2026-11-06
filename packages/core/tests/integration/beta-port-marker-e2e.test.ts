/**
 * ISS-1045: a forge-beta comment is a port marker only by its own first non-empty line. sidpeak beta
 * ISS-626 held a beta master's prose explaining the bridge ("…the port posts 'Ported to forge-dev:'
 * here…") and later a correct "Ported to forge-dev: FB-10"; the fire read the first comment matching
 * the phrase anywhere, found no key in it, and listed the row as "skipped as already ported" with no
 * key, so it was neither ported nor mirrored. Here: prose quoting the phrase ports as any row; a
 * marker with no key, or a key naming nothing in the twin, is held and named with the line to write,
 * never skipped; a keyed marker is adopted, after prose and over a keyless marker, whichever came
 * first. forge-beta is a stub HTTP server this file starts and stops. Against real Postgres.
 *
 * @direct-test-of packages/core/src/beta-port/run.ts
 * @direct-test-of packages/core/src/beta-port/markers.ts
 * @direct-test-of packages/core/src/beta-port/report.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  betaPortScheduleOn,
  devFeedbackOf,
  fireOnce,
  putBetaSecret,
  type Say,
} from '../helpers/beta-port-harness.js';
import {
  beta,
  betaIssue,
  outsideGitDocument,
  RULING_AT,
  type StubIssue,
  startBeta,
  stopBeta,
  TOKEN,
  writeRuling,
} from '../helpers/beta-port-world.js';
import { closeWorld, requester, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, rows } from '../helpers/factories.js';

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

const fire = () => fireOnce(say, scheduleId);
const push = (...issues: StubIssue[]) => beta.issues.get(betaProjectId)?.push(...issues);
const LINE_TO_WRITE = "write `Ported to forge-dev: <ISS-n|FB-n>` as the comment's first line";

/** The beta master's comment on sidpeak beta ISS-626, as it explained the bridge in prose. */
const PROSE =
  "Decision: left for the automatic port, which files it on forge-dev | the port posts 'Ported to forge-dev:' here; none after 4 min, so it waits for the next fire.";

/** A Feedback item filed in the twin by hand, as sidpeak FB-10 was: its id and key. */
async function handFiled(title: string): Promise<{ id: string; key: string }> {
  const filed = await say('owner', 'POST', `/api/projects/${twin.id}/feedback`, {
    kind: 'bug',
    title,
    screen: 'forge-beta',
  });
  expect(filed.status, JSON.stringify(filed.json)).toBe(201);
  return (filed.json as { feedback: { id: string; key: string } }).feedback;
}

async function pairOf(b: StubIssue) {
  const [row] = await rows<{ dev_issue_id: string | null; dev_feedback_id: string | null }>(
    sql`SELECT dev_issue_id, dev_feedback_id FROM beta_port_pairs WHERE beta_issue_id = ${b.id}`,
  );
  return row ?? null;
}

describe('a beta port marker is a comment first line (ISS-1045)', () => {
  it('ports a row whose comment only quotes the phrase in prose, as any other row', async () => {
    const quoted = betaIssue(60);
    push(quoted);
    beta.comments.set(quoted.id, [PROSE]);
    const settled = await fire();
    expect(settled.status, JSON.stringify(settled)).toBe('success');
    const item = (await devFeedbackOf(twin.id)).find((f) => f.where_seen === 'forge-beta ISS-60');
    expect(item, settled.output ?? '').toBeDefined();
    const fbKey = `FB-${item?.fb_seq}`;
    expect(settled.output).toContain(`${twin.slug}: beta ISS-60 → ${fbKey}`);
    expect(settled.output).not.toContain('ISS-60 (marked ported');
    expect(beta.comments.get(quoted.id)).toEqual([PROSE, `Ported to forge-dev: ${fbKey}`]);
    expect(await pairOf(quoted)).toEqual({ dev_issue_id: null, dev_feedback_id: item?.id });
  });

  it('holds a row whose first line is a marker with no key, names the line to write, and never lists it as skipped', async () => {
    const keyless = betaIssue(61);
    push(keyless);
    beta.comments.set(keyless.id, ['Ported to forge-dev\n\nby hand, key to follow']);
    const before = (await devFeedbackOf(twin.id)).length;
    for (const settled of [await fire(), await fire()]) {
      expect(settled.output).toContain(
        `${twin.slug}: beta ISS-61: marked ported by hand but names no dev key; ${LINE_TO_WRITE}`,
      );
      expect(settled.output).toMatch(/^held \(\d+\):$/m);
      expect(settled.output).not.toContain('ISS-61 (marked ported');
      expect(settled.output).not.toMatch(/ISS-61 → /);
    }
    expect(await devFeedbackOf(twin.id)).toHaveLength(before);
    expect(await pairOf(keyless)).toBeNull();
    expect(beta.comments.get(keyless.id)).toHaveLength(1);
  });

  it('holds a row whose marker key names nothing in the twin, naming the key and the line to write', async () => {
    const stray = betaIssue(62);
    push(stray);
    beta.comments.set(stray.id, ['Ported to forge-dev: FB-9999 by hand']);
    const settled = await fire();
    expect(settled.output).toContain(
      `${twin.slug}: beta ISS-62: marked ported to FB-9999, which names nothing in ${twin.slug}; ${LINE_TO_WRITE}`,
    );
    expect(settled.output).not.toContain('ISS-62 (marked ported');
    expect(await pairOf(stray)).toBeNull();
  });

  it('adopts a row marked "Ported to forge-dev: FB-n" as that item', async () => {
    const marked = betaIssue(63);
    const fb = await handFiled('Hand ported beta ISS-63');
    push(marked);
    beta.comments.set(marked.id, [`Ported to forge-dev: ${fb.key}`]);
    const settled = await fire();
    expect(settled.output).toContain(`ISS-63 (marked ported to ${fb.key})`);
    expect(await pairOf(marked)).toEqual({ dev_issue_id: null, dev_feedback_id: fb.id });
  });

  it('adopts a row whose prose quoting the phrase comes before its keyed marker, as sidpeak beta ISS-626 stood', async () => {
    const live = betaIssue(64);
    const fb = await handFiled('Hand ported beta ISS-64');
    push(live);
    beta.comments.set(live.id, [PROSE, `Ported to forge-dev: ${fb.key}`]);
    const settled = await fire();
    expect(settled.output).toContain(`ISS-64 (marked ported to ${fb.key})`);
    expect(settled.output).not.toContain('ISS-64 (marked ported)');
    expect(await pairOf(live)).toEqual({ dev_issue_id: null, dev_feedback_id: fb.id });
  });

  it('adopts by the keyed marker where a keyless marker came first', async () => {
    const both = betaIssue(65);
    const fb = await handFiled('Hand ported beta ISS-65');
    push(both);
    beta.comments.set(both.id, ['Ported to forge-dev', `Ported to forge-dev: ${fb.key}`]);
    const settled = await fire();
    expect(settled.output).toContain(`ISS-65 (marked ported to ${fb.key})`);
    expect(settled.output).not.toContain('beta ISS-65: marked ported by hand');
    expect(await pairOf(both)).toEqual({ dev_issue_id: null, dev_feedback_id: fb.id });
  });
});
