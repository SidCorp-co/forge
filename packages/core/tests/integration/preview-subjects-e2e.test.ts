import { SKETCH_BRANCH } from '@forge/contracts/preview';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The preview site, set before the process reads its environment: a development `host:port`.
vi.hoisted(() => {
  process.env.PREVIEW_DOMAIN = 'preview.localhost:7311';
});

import { api } from '../helpers/api.js';
import { settleOutbox } from '../helpers/ecosystem-world.js';
import { createTestFeedback, createTestRequirement } from '../helpers/factories.js';
import { LATER, SHIPPED, SubjectsWorld } from '../helpers/preview-subjects-world.js';

// REQ-41 r1 (docs/proposals/chat-first.md "Idea preview", "Reproduce"): a preview no issue's run
// holds. An idea is built by a sketch run on a branch its box cuts (BC-14) and edited from chat
// (BC-15); a feedback item opens its reporter's build (BC-17) on demo data (BC-22); a fix preview
// takes the reporter's word (BC-20). How a reproduce records: preview-recording-e2e.test.ts.

const world = new SubjectsWorld();
let owner = '';
let member = '';
let stranger = '';
let projectId = '';
let ownerId = '';

beforeAll(async () => {
  await world.start();
  ({ owner, member, stranger, projectId, ownerId } = world);
}, 120_000);

afterAll(() => world.stop());

describe('a reproduce serves the build its reporter used, on demo data (BC-17, BC-22)', () => {
  it('refuses an item it does not know and a build it cannot tell, naming what to give', async () => {
    const unknown = await api(owner, 'POST', `/api/projects/${projectId}/previews`, {
      kind: 'reproduce',
      feedback: 'FB-999',
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: 'PREVIEW_ITEM_UNKNOWN' });

    const fb = await createTestFeedback(projectId, ownerId, 40);
    await world.backdateFeedback(fb, new Date('2026-01-01T00:00:00Z'));
    const untold = await api(owner, 'POST', `/api/projects/${projectId}/previews`, {
      kind: 'reproduce',
      feedback: fb,
    });
    expect(untold.status).toBe(422);
    expect(untold.body).toMatchObject({ code: 'PREVIEW_BUILD_UNKNOWN' });
    expect(String(untold.body.detail)).toContain('name a release or a sha');
    const noSuchRelease = await api(owner, 'POST', `/api/projects/${projectId}/previews`, {
      kind: 'reproduce',
      feedback: fb,
      build: { release: '9.9.9' },
    });
    expect(noSuchRelease.body).toMatchObject({ code: 'PREVIEW_BUILD_UNKNOWN' });
    expect(
      (
        await api(stranger, 'POST', `/api/projects/${projectId}/previews`, {
          kind: 'reproduce',
          feedback: fb,
        })
      ).status,
    ).toBeGreaterThanOrEqual(403);
  });

  it('takes the release live when the item was filed, checks it out with no run, and seeds the demo data first', async () => {
    await world.shipRelease('1.4.0', SHIPPED, new Date('2026-09-01T00:00:00Z'));
    await world.shipRelease('1.5.0', LATER, new Date('2026-09-20T00:00:00Z'));
    const fb = await createTestFeedback(projectId, ownerId, 41);
    await world.backdateFeedback(fb, new Date('2026-09-10T00:00:00Z'));
    world.serveApp();
    const opened = await api(owner, 'POST', `/api/projects/${projectId}/previews`, {
      kind: 'reproduce',
      feedback: fb,
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const preview = opened.body.preview as Record<string, unknown>;
    expect(preview).toMatchObject({
      subject: {
        kind: 'reproduce',
        feedback: fb,
        build: { sha: SHIPPED, release: '1.4.0' },
        record: true,
      },
      issueId: null,
      sessionId: null,
    });
    await settleOutbox();
    const start = (
      await world.box.until('preview.start', world.box.heardOf('preview.start').length)
    ).data;
    expect(start).toMatchObject({
      previewId: preview.id,
      sessionId: null,
      seed: 'npm run seed:demo',
      checkout: { kind: 'reproduce', repoPath: '/srv/checkout', sha: SHIPPED },
      env: { FORGE_ENVIRONMENT: 'demo', FORGE_ENVIRONMENT_URL: 'https://demo.shop.example.test' },
    });
    expect(String((start.checkout as { path: string }).path)).toMatch(
      /^\/srv\/checkout\/\.claude\/worktrees\/reproduce-fb-41-[a-z2-7]{6}$/,
    );

    // a named release and a named sha are served as named, the sha read back to its release
    const byRelease = await api(owner, 'POST', `/api/projects/${projectId}/previews`, {
      kind: 'reproduce',
      feedback: fb,
      build: { release: '1.5.0' },
      record: false,
    });
    expect(byRelease.body.preview).toMatchObject({
      subject: { build: { sha: LATER, release: '1.5.0' }, record: false },
    });
    const bySha = await api(owner, 'POST', `/api/projects/${projectId}/previews`, {
      kind: 'reproduce',
      feedback: fb,
      build: { sha: LATER.toUpperCase() },
    });
    expect(bySha.body.preview).toMatchObject({
      subject: { build: { sha: LATER, release: '1.5.0' } },
    });
  });
});

describe('an idea is built by a sketch run and edited from chat (BC-14, BC-15)', () => {
  it('cuts a sketch branch on the box, briefs the run once its dev server serves, and takes a change as it works', async () => {
    const req = await createTestRequirement(projectId, 7, 'Checkout shows the order total');
    const unknown = await api(owner, 'POST', `/api/projects/${projectId}/previews`, {
      kind: 'idea',
      about: 'REQ-404',
      brief: 'x',
    });
    expect(unknown.body).toMatchObject({ code: 'PREVIEW_ITEM_UNKNOWN' });

    world.serveVite();
    const opened = await api(owner, 'POST', `/api/projects/${projectId}/previews`, {
      kind: 'idea',
      about: req.key,
      brief: 'Show the total in bold under the cart',
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const preview = opened.body.preview as {
      id: string;
      sessionId: string;
      subject: { kind: string; branch: string; about: unknown };
    };
    expect(preview.subject).toMatchObject({
      kind: 'idea',
      about: { kind: 'requirement', key: req.key },
    });
    expect(preview.subject.branch).toMatch(SKETCH_BRANCH);
    expect(preview.subject.branch).toMatch(/^sketch\/req-7-/);
    await settleOutbox();
    const start = (
      await world.box.until('preview.start', world.box.heardOf('preview.start').length)
    ).data;
    const checkout = start.checkout as { kind: string; branch: string; path: string };
    expect(start).toMatchObject({ sessionId: preview.sessionId, seed: null });
    expect(checkout).toMatchObject({
      kind: 'sketch',
      branch: preview.subject.branch,
      repoPath: '/srv/checkout',
      base: null,
    });
    expect(checkout.path).toBe(
      `/srv/checkout/.claude/worktrees/${preview.subject.branch.replace('/', '-')}`,
    );

    const brief = await world.box.until('agent:start');
    expect(brief.data).toMatchObject({ sessionId: preview.sessionId, repoPath: checkout.path });
    expect(String(brief.data.prompt)).toContain('Show the total in bold under the cart');
    expect(String(brief.data.prompt)).toContain('never push');

    const asked = Date.now();
    const sent = await api(owner, 'POST', `/api/previews/${preview.id}/messages`, {
      text: 'make it green',
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    await settleOutbox();
    const told = await world.box.until('session.send');
    expect(told.data).toMatchObject({ sessionId: preview.sessionId, kind: 'inject' });
    expect(String(told.data.body)).toContain('make it green');
    expect(Date.now() - asked).toBeLessThan(5_000);

    expect((await api(owner, 'POST', `/api/previews/${preview.id}/approve`)).body).toMatchObject({
      code: 'PREVIEW_NO_RUN',
    });
  });
});

describe("a fix preview takes the reporter's word, bound to the patch it served (BC-20)", () => {
  it('records fixed and not fixed per routed item, and refuses a preview that fixes nothing reported', async () => {
    world.serveVite();
    world.box.devPort = world.dev.port;
    const issueId = await world.issueWithRun();
    const preview = await world.livePreview(issueId);
    const unrouted = await api(member, 'POST', `/api/previews/${preview.id}/confirm`, {
      verdict: 'fixed',
    });
    expect(unrouted.status).toBe(409);
    expect(unrouted.body).toMatchObject({ code: 'PREVIEW_CONFIRM_NOT_FIX' });

    await createTestFeedback(projectId, ownerId, 60, [issueId]);
    const noNote = await api(member, 'POST', `/api/previews/${preview.id}/confirm`, {
      verdict: 'not_fixed',
    });
    expect(noNote.status).toBe(400);
    expect(noNote.body).toMatchObject({ code: 'PREVIEW_CONFIRM_REASON_REQUIRED' });

    const confirming = api(member, 'POST', `/api/previews/${preview.id}/confirm`, {
      verdict: 'fixed',
    });
    await settleOutbox();
    await world.box.until(
      'preview.snapshot.read',
      world.box.heardOf('preview.snapshot.read').length + 1,
    );
    const patchId = 'e'.repeat(40);
    await world.box.report(preview.id, {
      kind: 'snapshot',
      base: 'f'.repeat(40),
      patchId,
      files: ['a.ts'],
    });
    const confirmed = await confirming;
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);
    expect(confirmed.body.confirmations).toEqual([
      expect.objectContaining({ patchId, verdict: 'fixed', note: null, by: world.memberId }),
    ]);
  });
});
