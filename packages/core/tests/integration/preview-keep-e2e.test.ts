import { SKETCH_BRANCH } from '@forge/contracts/preview';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The preview site, set before the process reads its environment: a development `host:port`.
vi.hoisted(() => {
  process.env.PREVIEW_DOMAIN = 'preview.localhost:7311';
});

import { sql } from 'drizzle-orm';
import { buildOfferPreviewToolset } from '../../src/assistant/tools/offer-preview-tool.js';
import { db } from '../../src/db/client.js';
import { api } from '../helpers/api.js';
import { settleOutbox } from '../helpers/ecosystem-world.js';
import { createTestFeedback, createTestUser } from '../helpers/factories.js';
import { SubjectsWorld } from '../helpers/preview-subjects-world.js';
import { atPreview, cookieOf } from '../helpers/preview-world.js';

// REQ-41 r1 BC-14, BC-15, BC-16 (docs/proposals/chat-first.md "Idea preview"): an idea preview's
// pages answer Forge's ask for one rrweb snapshot (no recording is made), and keeping the preview
// writes the requirement's picture of kind `preview` (the sketch branch's head, the patch id the
// box reports, the page's still, scrubbed) and offers the criteria as a suggestion. Driven over real
// sockets: core, the project's app under its own `script-src 'self'`, and a box.

const world = new SubjectsWorld();
let owner = '';
let member = '';
let stranger = '';
let projectId = '';
let ownerId = '';

const HEAD = 'c'.repeat(40);
const BASE = 'a'.repeat(40);
const PATCH = 'd'.repeat(40);

const snapshotOf = (text: string) => [
  { type: 4, timestamp: 1, data: { href: 'http://x.invalid/', width: 800, height: 600 } },
  {
    type: 2,
    timestamp: 2,
    data: { node: { type: 0, childNodes: [{ type: 3, textContent: text, id: 2 }], id: 1 } },
  },
];

/** The box as `runner-preview` answers a keep: it committed the sketch, and reports its head. */
const keepAnswer = (frame: Record<string, unknown>) => ({
  kind: 'snapshot',
  base: BASE,
  patchId: PATCH,
  files: ['packages/web-v2/src/app/page.tsx'],
  ...(frame.keep ? { head: HEAD } : {}),
});

async function requirementOf(title: string, kind: string | null): Promise<string> {
  const made = await api(owner, 'POST', `/api/projects/${projectId}/requirements`, {
    title,
    reason: 'the rule it states',
    ...(kind === null ? {} : { kind }),
    criteria: [{ body: 'A buyer sees what shipping costs before paying.' }],
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return String(made.body.key);
}

async function liveIdea(
  about: string,
  brief: string,
): Promise<{ id: string; url: string; branch: string }> {
  world.serveApp();
  const opened = await api(owner, 'POST', `/api/projects/${projectId}/previews`, {
    kind: 'idea',
    about,
    brief,
  });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  const preview = opened.body.preview as {
    id: string;
    url: string;
    subject: { branch: string };
  };
  await settleOutbox();
  await expect
    .poll(async () => (await api(owner, 'GET', `/api/previews/${preview.id}`)).body.preview, {
      timeout: 15_000,
      interval: 100,
    })
    .toMatchObject({ state: 'live' });
  return { id: preview.id, url: preview.url, branch: preview.subject.branch };
}

const keep = (who: string, id: string, body: unknown) =>
  api(who, 'POST', `/api/previews/${id}/keep`, body);

beforeAll(async () => {
  await world.start();
  ({ owner, member, stranger, projectId, ownerId } = world);
  world.box.onSnapshot = keepAnswer;
}, 120_000);

afterAll(() => world.stop());

describe("an idea's page answers Forge's ask for its snapshot and records nothing (BC-16)", () => {
  it("carries the snapshot script after <head>, answered by core on the app's own origin", async () => {
    const key = await requirementOf('Checkout shows the shipping cost', 'screen');
    const idea = await liveIdea(key, 'Show the shipping cost under the cart');
    const cookie = cookieOf((await world.enter(idea)).entered.headers['set-cookie']);
    const page = await atPreview(world.core, idea.url, '/', { cookie, 'accept-encoding': 'gzip' });
    expect(page.text).toContain(
      '<head><script src="/__forge_preview/rec.js"></script><title>shop</title>',
    );
    expect(world.appSeen.at(-1)?.headers['accept-encoding']).toBe('identity');
    const script = await atPreview(world.core, idea.url, '/__forge_preview/rec.js', { cookie });
    expect(script.status).toBe(200);
    expect(script.text).toContain('"maskAllInputs":true');
    expect(script.text).toContain('forge.preview.snapshot.ask');
    expect(script.text).toContain('"parent":"http://localhost:3000"');
    expect(script.text).not.toContain('/__forge_preview/rec"'); // no ingest path: nothing is sent anywhere
    // its pages post no batch: the ingest path is not an idea's
    const batch = await world.postAtPreview(idea.url, '/__forge_preview/rec', { cookie }, '{}');
    expect(batch.status).toBe(404);
    const recordings = (await db.execute(
      sql`SELECT count(*)::int AS n FROM preview_recordings WHERE preview_id = ${idea.id}::uuid`,
    )) as unknown as { n: number }[];
    expect(recordings[0]?.n).toBe(0);
  });

  it("does not put the script on an issue's preview", async () => {
    const preview = await world.livePreview(world.issueId);
    const cookie = cookieOf((await world.enter(preview)).entered.headers['set-cookie']);
    const page = await atPreview(world.core, preview.url, '/', { cookie });
    expect(page.text).not.toContain('__forge_preview/rec.js');
    expect(
      (await atPreview(world.core, preview.url, '/__forge_preview/rec.js', { cookie })).status,
    ).toBe(404);
  });
});

describe('a kept idea about a requirement is its picture, and its criteria are suggested (BC-16)', () => {
  it("writes a picture of kind preview on the head with the branch head, the patch id and the page's scrubbed still", async () => {
    const key = await requirementOf('Checkout shows the order total', 'screen');
    const idea = await liveIdea(key, 'Show the total in bold under the cart');
    expect(idea.branch).toMatch(SKETCH_BRANCH);
    await api(owner, 'POST', `/api/previews/${idea.id}/messages`, { text: 'make it green' });

    const kept = await keep(owner, idea.id, {
      alt: 'The cart with its total in bold green',
      snapshot: snapshotOf(
        'Total 12.00, mail jane.doe@example.com token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      ),
    });
    expect(kept.status, JSON.stringify(kept.body)).toBe(201);
    expect(kept.body).toMatchObject({
      requirement: key,
      revision: 1,
      startedFrom: null,
      suggestionRefusal: null,
    });

    const detail = (await api(owner, 'GET', `/api/projects/${projectId}/requirements/${key}`)).body;
    const shown = (
      detail.revisions as {
        revision: number;
        picture: { kind: string; content: Record<string, unknown> & { snapshot: unknown } } | null;
      }[]
    ).find((r) => r.revision === 1)?.picture;
    expect(shown).toMatchObject({
      kind: 'preview',
      alt: 'The cart with its total in bold green',
      roughSketch: true,
      content: {
        previewId: idea.id,
        branch: idea.branch,
        head: HEAD,
        base: BASE,
        patchId: PATCH,
        files: ['packages/web-v2/src/app/page.tsx'],
        asked: ['Show the total in bold under the cart', 'make it green'],
      },
    });
    const stored = JSON.stringify(shown?.content.snapshot);
    expect(stored).toContain('Total 12.00');
    expect(stored).not.toContain('jane.doe@example.com');
    expect(stored).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');

    // the criteria are an assistant suggestion with its recommendation, not a write into the revision
    expect(kept.body.suggestionId).toEqual(expect.any(String));
    const listed = (
      await api(owner, 'GET', `/api/projects/${projectId}/suggestions?requirement=${key}`)
    ).body.suggestions as {
      id: string;
      kind: string;
      status: string;
      producerKind: string;
      payload: { reason: string; criteria: { code?: string; body: string }[] };
    }[];
    const s = listed.find((x) => x.id === kept.body.suggestionId);
    expect(s).toMatchObject({
      kind: 'revision_diff',
      status: 'proposed',
      producerKind: 'ba_assistant',
    });
    expect(s?.payload.reason).toMatch(/^Recommended: accept\./);
    expect(s?.payload.criteria.map((c: { body: string }) => c.body)).toEqual([
      'A buyer sees what shipping costs before paying.',
      'The page does what was asked: Show the total in bold under the cart',
      'The page does what was asked: make it green',
    ]);
    expect(s?.payload.criteria[0]?.code).toBe('BC-1');
    expect((detail.revisions as { criteria: unknown[] }[])[0]?.criteria).toHaveLength(1);
  });

  it('reopens live from the kept head: the sketch is cut at it, and an unkept preview is refused by name', async () => {
    const key = await requirementOf('Checkout shows the delivery date', 'screen');
    const idea = await liveIdea(key, 'Show the delivery date');
    expect(
      (
        await keep(owner, idea.id, {
          alt: 'The delivery date',
          snapshot: snapshotOf('Delivery 3 days'),
        })
      ).status,
    ).toBe(201);
    const before = world.box.heardOf('preview.start').length;
    const again = await api(owner, 'POST', `/api/projects/${projectId}/previews`, {
      kind: 'idea',
      about: key,
      brief: 'Make the date larger',
      from: idea.id,
    });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    await settleOutbox();
    const start = (await world.box.until('preview.start', before + 1)).data;
    expect(start.checkout).toMatchObject({ kind: 'sketch', base: HEAD });
    expect((again.body.preview as { id: string }).id).not.toBe(idea.id);

    const unkept = await api(owner, 'POST', `/api/projects/${projectId}/previews`, {
      kind: 'idea',
      about: key,
      brief: 'x',
      from: '8df98619-9f7c-46b8-8e65-a67f2fcdce74',
    });
    expect(unkept.status).toBe(404);
    expect(unkept.body).toMatchObject({ code: 'PREVIEW_NOT_FOUND' });
  });

  it('refuses a keep that is not an idea, not a snapshot, not a member, or not reported by the box, by name', async () => {
    const issuePreview = await world.livePreview(await world.issueWithRun());
    const notIdea = await keep(owner, issuePreview.id, { alt: 'x', snapshot: snapshotOf('x') });
    expect(notIdea.status).toBe(409);
    expect(notIdea.body).toMatchObject({ code: 'PREVIEW_KEEP_NOT_IDEA' });

    const key = await requirementOf('Checkout shows the coupon box', 'screen');
    const idea = await liveIdea(key, 'Show a coupon box');
    const lone = await keep(owner, idea.id, { alt: 'x', snapshot: snapshotOf('x').slice(0, 1) });
    expect(lone.status).toBe(400);
    expect(lone.body).toMatchObject({ code: 'PREVIEW_KEEP_SNAPSHOT_INVALID' });
    const swapped = await keep(owner, idea.id, {
      alt: 'x',
      snapshot: [...snapshotOf('x')].reverse(),
    });
    expect(swapped.body).toMatchObject({ code: 'PREVIEW_KEEP_SNAPSHOT_INVALID' });

    expect(
      (await keep(stranger, idea.id, { alt: 'x', snapshot: snapshotOf('x') })).status,
    ).toBeGreaterThanOrEqual(403);

    // a box that does not commit a sketch reports no head: nothing is kept, and it says why
    world.box.onSnapshot = (frame) => {
      const { head: _head, ...rest } = keepAnswer(frame) as Record<string, unknown>;
      return rest;
    };
    const headless = await keep(owner, idea.id, { alt: 'x', snapshot: snapshotOf('x') });
    expect(headless.status).toBe(503);
    expect(headless.body).toMatchObject({ code: 'PREVIEW_SNAPSHOT_UNAVAILABLE' });
    world.box.onSnapshot = keepAnswer;
    const detail = (await api(owner, 'GET', `/api/projects/${projectId}/requirements/${key}`)).body;
    expect((detail.revisions as { picture: unknown }[])[0]?.picture).toBeNull();
  });

  it('refuses the picture route a kept preview, and a requirement whose kind takes no preview, by name', async () => {
    const process = await requirementOf('A process requirement', 'process');
    const forged = await api(
      owner,
      'PUT',
      `/api/projects/${projectId}/requirements/${process}/revisions/1/picture`,
      {
        kind: 'preview',
        alt: 'forged',
        content: {},
      },
    );
    expect(forged.status).toBe(400);
    const idea = await liveIdea(process, 'Draw it');
    const kept = await keep(owner, idea.id, { alt: 'x', snapshot: snapshotOf('x') });
    expect(kept.status).toBe(422);
    expect(JSON.stringify(kept.body)).toContain('REQUIREMENT_PICTURE_KIND_MISMATCH');
  });
});

describe('a kept idea about feedback starts a requirement draft from it (BC-16)', () => {
  it('creates the screen requirement with the picture and the criteria suggestion', async () => {
    const fb = await createTestFeedback(projectId, ownerId, 61);
    const idea = await liveIdea(fb, 'A larger chat box');
    const kept = await keep(member, idea.id, {
      alt: 'The home with a larger chat box',
      snapshot: snapshotOf('Chat'),
    });
    expect(kept.status, JSON.stringify(kept.body)).toBe(201);
    expect(kept.body).toMatchObject({ startedFrom: fb, revision: 1 });
    const key = String(kept.body.requirement);
    const detail = (await api(owner, 'GET', `/api/projects/${projectId}/requirements/${key}`)).body;
    expect(detail).toMatchObject({ status: 'draft' });
    expect((detail.revisions as { kind: string; picture: { kind: string } }[])[0]).toMatchObject({
      kind: 'screen',
      picture: { kind: 'preview' },
    });
    expect(kept.body.suggestionId).toEqual(expect.any(String));
  });
});

describe('the assistant offers an idea preview and opens nothing (BC-14)', () => {
  it('offers for an item of the project the person may open a preview on, and refuses by name otherwise', async () => {
    const key = await requirementOf('Checkout shows a gift note', 'screen');
    const before = (await db.execute(sql`SELECT count(*)::int AS n FROM previews`)) as unknown as {
      n: number;
    }[];
    const tools = buildOfferPreviewToolset({ projectId, userId: ownerId });
    const text = async (name: string, args: unknown) => {
      const r = await tools.execute(name, JSON.stringify(args));
      return { error: Boolean(r.isError), text: String((r.content[0] as { text: string }).text) };
    };
    const offered = await text('offer_preview', { about: key, brief: 'Show a gift note box' });
    expect(offered.error).toBe(false);
    expect(JSON.parse(offered.text).offer).toMatchObject({
      v: 1,
      projectId,
      about: key,
      brief: 'Show a gift note box',
    });
    const unknown = await text('offer_preview', { about: 'REQ-4040', brief: 'x' });
    expect(unknown.text).toContain('IDEA_OFFER_ITEM_UNKNOWN');
    expect(unknown.error).toBe(true);
    const bad = await text('offer_preview', { about: 'ISS-1', brief: 'x' });
    expect(bad.text).toContain('IDEA_OFFER_INVALID');
    const outsider = buildOfferPreviewToolset({
      projectId,
      userId: (await createTestUser({ verified: true })).id,
    });
    const forbidden = await outsider.execute(
      'offer_preview',
      JSON.stringify({ about: key, brief: 'x' }),
    );
    expect(forbidden.isError).toBe(true);
    expect(String((forbidden.content[0] as { text: string }).text)).toContain(
      'IDEA_OFFER_FORBIDDEN',
    );
    const after = (await db.execute(sql`SELECT count(*)::int AS n FROM previews`)) as unknown as {
      n: number;
    }[];
    expect(after[0]?.n).toBe(before[0]?.n);
  });
});
