import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

// The preview site, set before the process reads its environment: a development `host:port`.
vi.hoisted(() => {
  process.env.PREVIEW_DOMAIN = 'preview.localhost:7311';
});

import { transitionSessions } from '../../src/agent-sessions/index.js';
import { db } from '../../src/db/client.js';
import { agentSessions } from '../../src/db/schema.js';
import { sweepPreviews } from '../../src/previews/service.js';
import { api } from '../helpers/api.js';
import { settleOutbox } from '../helpers/ecosystem-world.js';
import { createTestRequirement } from '../helpers/factories.js';
import { SubjectsWorld } from '../helpers/preview-subjects-world.js';

// REQ-41 BC-14, BC-15 and REQ-39 BC-9: an idea's preview outlives the turn that built it. The sketch
// run is a chat session whose turn completes once the change is built; the preview then ends only by
// keep, abandon, idle close, or its box reporting the checkout released. An issue run's preview still
// ends with its run.

const world = new SubjectsWorld();
let owner = '';
let projectId = '';
let seq = 100;

beforeAll(async () => {
  await world.start();
  ({ owner, projectId } = world);
}, 120_000);

afterAll(() => world.stop());

const stateOf = async (id: string) =>
  (await api(owner, 'GET', `/api/previews/${id}`)).body.preview as {
    state: string;
    detail: string | null;
  };

/** The session's turn ends: a chat session is `completed` when its turn does. */
const complete = (sessionId: string | undefined) =>
  transitionSessions(db, {
    to: 'completed',
    where: eq(agentSessions.id, sessionId as string),
    actor: { type: 'system' },
    source: 'preview-sketch-life-e2e',
  });

interface Sketch {
  id: string;
  sessionId: string;
  path: string;
}

/** An idea preview, live, whose sketch run has taken its brief and finished that turn. */
async function sketchAfterItsTurn(): Promise<Sketch> {
  seq += 1;
  const req = await createTestRequirement(projectId, seq, `Idea ${seq}`);
  const heard = world.box.heardOf('agent:start').length;
  const opened = await api(owner, 'POST', `/api/projects/${projectId}/previews`, {
    kind: 'idea',
    about: req.key,
    brief: 'Show the total in bold',
  });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  const preview = opened.body.preview as { id: string; sessionId: string };
  await settleOutbox();
  await expect
    .poll(async () => (await stateOf(preview.id)).state, { timeout: 15_000 })
    .toBe('live');
  const brief = await world.box.until('agent:start', heard + 1);
  // the run's turn completes: the session is `completed`, as a chat session's is when a turn ends
  await complete(preview.sessionId);
  return { id: preview.id, sessionId: preview.sessionId, path: String(brief.data.repoPath) };
}

it('stays live after the sketch turn completed, and takes an edit turn in the same worktree (BC-14, BC-15)', async () => {
  const sketch = await sketchAfterItsTurn();
  expect((await stateOf(sketch.id)).state).toBe('live');
  await sweepPreviews();
  expect(await stateOf(sketch.id)).toMatchObject({ state: 'live', detail: null });
  await settleOutbox();
  expect(world.box.heardOf('preview.stop').filter((f) => f.data.previewId === sketch.id)).toEqual(
    [],
  );

  const heard = world.box.heardOf('agent:start').length + world.box.heardOf('agent:send').length;
  const sent = await api(owner, 'POST', `/api/previews/${sketch.id}/messages`, {
    text: 'make it green',
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await settleOutbox();
  await expect
    .poll(() => world.box.heardOf('agent:start').length + world.box.heardOf('agent:send').length, {
      timeout: 15_000,
    })
    .toBe(heard + 1);
  const frame = [...world.box.heardOf('agent:start'), ...world.box.heardOf('agent:send')].find(
    (f) => String(f.data.prompt ?? f.data.message).includes('make it green'),
  );
  expect(frame, 'no turn frame carried the edit').toBeDefined();
  expect(frame?.data).toMatchObject({ sessionId: sketch.sessionId, repoPath: sketch.path });
  expect((await stateOf(sketch.id)).state).toBe('live');
});

it('still closes by abandon, and by idle when nobody views it, after its turn completed (REQ-39 BC-9)', async () => {
  const abandoned = await sketchAfterItsTurn();
  const out = await api(owner, 'POST', `/api/previews/${abandoned.id}/abandon`, { reason: 'no' });
  expect(out.status, JSON.stringify(out.body)).toBe(200);
  expect(await stateOf(abandoned.id)).toMatchObject({ state: 'abandoned', detail: 'no' });
  await settleOutbox();
  expect(world.box.heardOf('preview.stop').at(-1)?.data).toEqual({
    previewId: abandoned.id,
    why: 'abandoned',
  });

  const idle = await sketchAfterItsTurn();
  await db.execute(
    sql`UPDATE previews SET last_viewed_at = now() - interval '2 hours' WHERE id = ${idle.id}`,
  );
  await sweepPreviews();
  expect((await stateOf(idle.id)).state).toBe('idle_closed');
  await settleOutbox();
  expect(world.box.heardOf('preview.stop').at(-1)?.data).toEqual({
    previewId: idle.id,
    why: 'idle',
  });
});

it('is abandoned, naming why, when its box reports the sketch checkout released', async () => {
  const sketch = await sketchAfterItsTurn();
  await db.execute(sql`
    INSERT INTO device_run_ledger (device_id, run_id, project_id, session_id, worktree_path, boot_id, incarnation, work, issues, worktree_gone_at)
    VALUES (${world.box.deviceId}, ${randomUUID()}, ${projectId}, ${sketch.sessionId}, ${sketch.path}, 'boot', 'closed', 'done', '[]'::jsonb, now())
  `);
  await sweepPreviews();
  expect(await stateOf(sketch.id)).toMatchObject({
    state: 'abandoned',
    detail: 'the run holding the worktree ended: its box reports the checkout released',
  });
});

it('a box that closed the sketch session on its ledger, but not the checkout, ends nothing', async () => {
  const sketch = await sketchAfterItsTurn();
  await db.execute(sql`
    INSERT INTO device_run_ledger (device_id, run_id, project_id, session_id, worktree_path, boot_id, incarnation, work, issues, session_terminal_at)
    VALUES (${world.box.deviceId}, ${randomUUID()}, ${projectId}, ${sketch.sessionId}, ${sketch.path}, 'boot', 'live', 'done', '[]'::jsonb, now())
  `);
  await sweepPreviews();
  expect((await stateOf(sketch.id)).state).toBe('live');
});

it("an issue run's preview still ends with its run (REQ-39 BC-9)", async () => {
  const issueId = await world.issueWithRun();
  const preview = await world.livePreview(issueId);
  const [row] = (await db.execute(
    sql`SELECT session_id FROM previews WHERE id = ${preview.id}`,
  )) as unknown as {
    session_id: string;
  }[];
  await complete(row?.session_id);
  await sweepPreviews();
  expect(await stateOf(preview.id)).toMatchObject({
    state: 'abandoned',
    detail: 'the run holding the worktree ended: its session is completed',
  });
});
