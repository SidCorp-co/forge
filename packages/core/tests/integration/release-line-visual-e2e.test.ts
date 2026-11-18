/**
 * ISS-1308: every New and Fixed line of a release page shows the clip or shots its judge marked, with
 * no requirement involved. Before it, a release page showed media only on requirement highlights, and
 * the last six releases of every project on dev read `highlights: none`, so every release read as
 * text while its judges' clips sat on the issues. Through the verdict door and the page read, against
 * real Postgres:
 * - a pass marks which attachments of its issue show the line; a file of another issue is refused
 *   by name, and so is a file named by its name, a mark on a fail, and a still with no clip;
 * - the page gives each line its marked visual, linked for the reader; a line of no requirement too;
 * - a line whose landing touched `ui` surfaces and shows nothing reads visual owed on the developer
 *   view, counted, until its judge marks one or says why none, and nothing is refused;
 * - the page's card carries the cover still and the shots its master's post names.
 *
 * @direct-test-of packages/core/src/issues/criteria/release-visual-mark.ts
 * @direct-test-of packages/core/src/issues/criteria/verdict-record.ts
 * @direct-test-of packages/core/src/issues/criteria/input-schemas.ts
 * @direct-test-of packages/core/src/release-page/visuals.ts
 * @direct-test-of packages/core/src/release-page/read.ts
 * @direct-test-of packages/core/src/release-page/share-source.ts
 * @direct-test-of packages/contracts/src/release-visual.ts
 */

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import type { ReleaseVisualMark } from '../../src/issues/criteria/release-visual-mark.js';
import { addVerdict } from '../../src/issues/criteria/service.js';
import { RefusalError } from '../../src/lib/refusal.js';
import { backgroundRefreshesSettled } from '../../src/release-page/index.js';
import { api, patToken, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';
import { plantLiveBuild } from '../helpers/live-build.js';
import { BUILD, releasePageWorld } from '../helpers/release-page-world.js';
import { declareProductionDocument, releaseWorld } from '../helpers/release-world.js';

let projectId: string;
let ownerId: string;
const tokens: Record<'owner' | 'member' | 'agent', string> = { owner: '', member: '', agent: '' };
const fx = releaseWorld(() => ({ projectId, ownerId }));
const world = releasePageWorld(() => ({ projectId, ownerId, call, fx }));
let unplant: (() => void) | null = null;

afterEach(async () => {
  unplant?.();
  await backgroundRefreshesSettled();
});

beforeEach(async () => {
  unplant = plantLiveBuild(BUILD);
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  tokens.owner = await userToken(ownerId);
  const member = await createTestUser({ verified: true });
  await addProjectMember(projectId, member.id, 'member');
  tokens.member = await userToken(member.id);
  const agentId = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, agentId, 'admin');
  tokens.agent = await patToken(agentId, [projectId], 'master');
  await fx.seedReleaseRunner();
  const bindingId = await fx.declareProduction({}, 'none');
  await declareProductionDocument({
    projectId,
    ownerId,
    bindingId,
    probes: 'none',
    others: { beta: { tier: 'staging', deployment: { mode: 'external' } } },
  });
});

function call(who: keyof typeof tokens, method: 'GET' | 'POST', path: string, body?: unknown) {
  return api(tokens[who], method, `/api/projects/${projectId}${path}`, body);
}

type File = { attachmentId: string; kind: string; url?: string } | null;
type Line = {
  issueKey: string;
  line: string;
  visual: { desktop: File; phone: File; still: File; seconds: number | null } | null;
};
type Page = {
  improvements: Line[];
  fixes: Line[];
  visualsOwed: { count: number; lines: { issueKey: string; kind: string }[] } | null;
  card: {
    cover: { attachmentId: string; clip: boolean; seconds: number | null } | null;
    lines: { issueKey: string }[];
    criteria: { proven: number; total: number };
    shots: { attachmentId: string }[];
    link: string;
    attachments: { target: string; attachmentId: string }[];
  } | null;
};

const page = async (view = 'user') => {
  const r = await call('member', 'GET', `/releases/0.1.0/page?view=${view}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as unknown as Page;
};

const keyOf = async (issueId: string) => {
  const [row] = [...(await db.execute(sql`SELECT iss_seq FROM issues WHERE id = ${issueId}`))];
  return `ISS-${(row as { iss_seq: number }).iss_seq}`;
};

const PNG = Buffer.from('png-bytes-of-a-shot');
const WEBM = Buffer.from('webm-bytes-of-a-clip');

/** A pass on criterion 1 of `issueId` at the build, marking `mark`, or the refusal it was given. */
async function markPass(
  issueId: string,
  mark: ReleaseVisualMark | null,
  extra: { verdict?: 'pass' | 'fail'; withoutClip?: string; evidence?: string[] } = {},
): Promise<string> {
  try {
    await addVerdict({
      issue: { id: issueId, projectId },
      draft: {
        criterion: 1,
        verdict: extra.verdict ?? 'pass',
        reason: extra.verdict === 'fail' ? 'the screen does not open' : null,
        identity: { kind: 'commit', sha: BUILD },
        evidence: extra.evidence ?? ['vitest'],
        withoutClip: extra.withoutClip ?? null,
        releaseVisual: mark,
      },
      author: { userId: ownerId, deviceId: null, agency: 'agent' },
    });
    return 'written';
  } catch (err) {
    if (err instanceof RefusalError) return err.refusals.map((r) => r.code).join(',');
    throw err;
  }
}

const verdictCount = async (issueId: string) =>
  Number(
    (
      [
        ...(await db.execute(
          sql`SELECT count(*)::int AS n FROM criterion_verdicts WHERE issue_id = ${issueId}`,
        )),
      ][0] as { n: number }
    ).n,
  );

/**
 * A cut release of two issues tracing no requirement: `screen` a New line whose landing touched a
 * `ui` surface, `quiet` a Fixed line that touched only logic.
 */
async function untracedRelease() {
  const screen = await fx.insertIssue(
    'awaiting_release',
    { section: 'Added', title: 'Boxes page', userFacing: 'Watch an agent test your app live.' },
    true,
    ['The Boxes page shows the agent driving the app'],
  );
  const quiet = await fx.insertIssue(
    'awaiting_release',
    { section: 'Fixed', title: 'Lessons settle', userFacing: 'Lessons settle after a room audit.' },
    true,
    ['A lesson settles after its audit'],
  );
  await db.execute(sql`
    UPDATE issues SET merged_artifacts = ${JSON.stringify([
      { surface: 'ui', ref: 'packages/web-v2/src/features/boxes/box-view.tsx', change: 'added' },
    ])}::jsonb WHERE id = ${screen}`);
  await db.execute(sql`
    UPDATE issues SET merged_artifacts = ${JSON.stringify([
      { surface: 'logic', ref: 'packages/core/src/lessons/pass.ts', change: 'changed' },
    ])}::jsonb WHERE id = ${quiet}`);
  const clip = await world.attach(screen, 'boxes.webm', 'video/webm', WEBM);
  const still = await world.attach(screen, 'boxes-still.png', 'image/png', PNG);
  const phone = await world.attach(screen, 'boxes-390.png', 'image/png', PNG);
  const shot = await world.attach(quiet, 'lessons.png', 'image/png', PNG);
  const cut = await call('owner', 'POST', '/release-batches', { issueIds: [screen, quiet] });
  expect(cut.status, JSON.stringify(cut.body)).toBe(201);
  return { screen, quiet, clip, still, phone, shot };
}

describe('a judge marks which attachments show its line (ISS-1308 c1)', () => {
  it('refuses a file of another issue by name, and writes nothing', async () => {
    const w = await untracedRelease();
    const before = await verdictCount(w.screen);
    expect(await markPass(w.screen, { desktop: w.shot })).toBe('VERDICT_RELEASE_VISUAL_FOREIGN');
    expect(await verdictCount(w.screen)).toBe(before);
  });

  it('refuses a file named by its name, a mark on a fail, and a still with no clip', async () => {
    const w = await untracedRelease();
    expect(await markPass(w.screen, { desktop: 'boxes.webm' })).toBe(
      'VERDICT_RELEASE_VISUAL_SHAPE',
    );
    expect(await markPass(w.screen, { desktop: w.clip }, { verdict: 'fail' })).toBe(
      'VERDICT_RELEASE_VISUAL_SHAPE',
    );
    expect(await markPass(w.screen, { desktop: w.phone, still: w.still })).toBe(
      'VERDICT_RELEASE_VISUAL_SHAPE',
    );
    expect(await markPass(w.screen, { still: w.still })).toBe('VERDICT_RELEASE_VISUAL_SHAPE');
  });

  it('takes the mark at the REST door by id and by download URL', async () => {
    const w = await untracedRelease();
    const r = await api(tokens.owner, 'POST', `/api/issues/${w.screen}/verdicts`, {
      criterion: 1,
      verdict: 'pass',
      identity: { kind: 'commit', sha: BUILD },
      evidence: ['boxes.webm'],
      releaseVisual: {
        desktop: `/api/attachments/${w.clip}/download`,
        phone: w.phone,
        still: w.still,
        seconds: 20,
      },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const [row] = [
      ...(await db.execute(sql`
        SELECT visual_desktop_id::text AS d, visual_phone_id::text AS p, visual_still_id::text AS s,
               visual_seconds AS n
          FROM criterion_verdicts WHERE id = ${String(r.body.verdictId)}`)),
    ];
    expect(row).toEqual({ d: w.clip, p: w.phone, s: w.still, n: 20 });
  });
});

describe('every New and Fixed line shows its marked visual, with no requirement (ISS-1308 c2)', () => {
  it('gives each line the visual its judge marked, linked for the reader', async () => {
    const w = await untracedRelease();
    expect(
      await markPass(w.screen, { desktop: w.clip, phone: w.phone, still: w.still, seconds: 20 }),
    ).toBe('written');
    expect(await markPass(w.quiet, { desktop: w.shot })).toBe('written');
    const p = await page();
    const [line] = p.improvements;
    expect(line?.issueKey).toBe(await keyOf(w.screen));
    expect(line?.visual?.desktop).toMatchObject({
      attachmentId: w.clip,
      kind: 'clip',
      url: `/api/attachments/${w.clip}/download`,
    });
    expect(line?.visual?.phone).toMatchObject({ attachmentId: w.phone, kind: 'picture' });
    expect(line?.visual?.still?.attachmentId).toBe(w.still);
    expect(line?.visual?.seconds).toBe(20);
    expect(p.fixes[0]?.visual?.desktop?.attachmentId).toBe(w.shot);
    expect(p.fixes[0]?.visual?.phone).toBeNull();
  });

  it('takes a mark down once a later fail stands on its criterion', async () => {
    const w = await untracedRelease();
    await markPass(w.screen, { desktop: w.clip, still: w.still });
    expect((await page()).improvements[0]?.visual).not.toBeNull();
    await markPass(w.screen, null, { verdict: 'fail' });
    expect((await page()).improvements[0]?.visual).toBeNull();
  });
});

describe('a ui line with no visual reads visual owed, counted, never refused (ISS-1308 c4)', () => {
  it('counts the line on the developer view only, until the judge marks one or says why none', async () => {
    const w = await untracedRelease();
    const owed = await page('developer');
    expect(owed.visualsOwed).toEqual({
      count: 1,
      lines: [{ issueKey: await keyOf(w.screen), line: 'Boxes page', kind: 'new' }],
    });
    expect((await page('user')).visualsOwed).toBeNull();

    // a pass with no mark is written all the same: owing a visual refuses nothing
    expect(await markPass(w.screen, null)).toBe('written');
    expect((await page('developer')).visualsOwed?.count).toBe(1);

    expect(
      await markPass(w.screen, null, { withoutClip: 'the change is a server redirect only' }),
    ).toBe('written');
    expect((await page('developer')).visualsOwed?.count).toBe(0);
  });

  it('owes nothing once the judge marks a visual', async () => {
    const w = await untracedRelease();
    await markPass(w.screen, { desktop: w.clip, still: w.still });
    expect((await page('developer')).visualsOwed).toEqual({ count: 0, lines: [] });
  });
});

describe("the release post's card carries the cover and the shots (ISS-1308 c5)", () => {
  it("names the clip's still as the cover, the other shots after it, and the page's link", async () => {
    const w = await untracedRelease();
    await markPass(w.screen, { desktop: w.clip, phone: w.phone, still: w.still, seconds: 20 });
    await markPass(w.quiet, { desktop: w.shot });
    const { card } = await page();
    expect(card?.cover).toEqual({
      attachmentId: w.still,
      issueKey: await keyOf(w.screen),
      clip: true,
      seconds: 20,
    });
    expect(card?.shots.map((s) => s.attachmentId)).toEqual([w.phone, w.shot]);
    expect(card?.attachments).toEqual(
      [w.still, w.phone, w.shot].map((attachmentId) => ({ target: 'issue', attachmentId })),
    );
    expect(card?.lines.map((l) => l.issueKey)).toEqual([
      await keyOf(w.screen),
      await keyOf(w.quiet),
    ]);
    expect(card?.link).toMatch(/\/releases\/0\.1\.0$/);
  });
});
