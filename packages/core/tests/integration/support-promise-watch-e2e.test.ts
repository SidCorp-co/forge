import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { tellProjectPromises } from '../../src/support/promise-watch.js';
import { api } from '../helpers/api.js';
import { createTestIssue, createTestProject, rows } from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';
import { refusalCodes, SupportWorld, type Turn } from '../helpers/support-world.js';

/**
 * @direct-test-of packages/core/src/support/promise.ts
 * @direct-test-of packages/core/src/support/promise-watch.ts
 * @direct-test-of packages/core/src/support/promise-rules.ts
 * @direct-test-of packages/core/src/support/promise-routes.ts
 * @direct-test-of packages/core/src/support/session-door.ts
 * @direct-test-of packages/core/src/support/ops-scope.ts
 * @direct-test-of packages/core/src/support/result.ts
 * @direct-test-of packages/core/src/release-batch/serving-reading.ts
 */

// ISS-1012, from FB-512 (sidpeak room, 2026-11-05): a release decider asked to be told when an issue
// reaches staging, and the room could only report what it had filed itself, while
// support.deployment wanted a target id it is never given. The room's session now promises it by the
// environment's own name, about any issue of a project it follows; the results watch answers it once,
// when staging first serves a commit holding the issue's landing, and a dropped issue or an
// environment no longer tracked is answered too. A promise it cannot keep is refused when asked.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const w = new SupportWorld();
const PROBE = 'https://staging.catalog.test/build-info';
const LANDING = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';
const OLDER = '9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c';
const TITLE = 'Orders show their delivery date';
let served = OLDER;
let roomId = '';
let outsider = '';
const issue = { landed: '', dropped: '', untracked: '' };

const environments = (withStaging: boolean) => ({
  ...(withStaging
    ? {
        staging: {
          tier: 'staging' as const,
          deploysFrom: 'main',
          deployment: { mode: 'external' as const },
          url: 'https://staging.catalog.test',
          verification: {
            runtime: [
              { type: 'http' as const, url: PROBE, path: 'commit', identifies: 'source' as const },
            ],
          },
        },
      }
    : {}),
  production: {
    tier: 'production' as const,
    deploysFrom: 'main',
    deployment: { mode: 'external' as const },
    url: 'https://catalog.test',
  },
});

/** Run `model` on the next member turn after `send`, and wait until it ran. */
async function onNextAsk(
  send: () => Promise<string>,
  model: (
    turn: Turn,
    act: (a: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ) => Promise<void>,
): Promise<string> {
  await w.settleWarm();
  let done = false;
  w.box.model = async (turn, act) => {
    if (done || !turn.messages.some((m) => m.from !== 'forge')) return;
    await model(turn, act);
    done = true;
  };
  const thread = await send();
  await expect.poll(() => done, { timeout: 15_000 }).toBe(true);
  return thread;
}

/** The session as a model plays it: each promise note it is handed, said once in the thread. */
function answersPromises(): { thread: string; text: string }[] {
  const notes: { thread: string; text: string }[] = [];
  w.box.model = async (turn, act) => {
    for (const m of turn.messages) {
      if (m.from !== 'forge' || !m.text.includes('You promised')) continue;
      notes.push({ thread: m.thread, text: m.text });
      const said = m.text.includes('It has:')
        ? `Tin vui: "${TITLE}" đã lên staging rồi nhé!`
        : 'Rất tiếc, việc này sẽ không lên staging nữa.';
      await act({ action: 'reply', thread: m.thread, text: said });
    }
  };
  return notes;
}

const promises = () =>
  rows<{
    issue_id: string;
    environment: string;
    asker_key: string;
    asker_label: string | null;
    state: string;
    served_commit: string | null;
    created_at: string;
    answered_at: string | null;
  }>(sql`SELECT * FROM support_promises WHERE room_id = ${roomId}::uuid ORDER BY created_at`);

const told = () =>
  rows<{ thread: string; output: { state: string } }>(sql`
    SELECT thread, output FROM support_actions
     WHERE room_id = ${roomId}::uuid AND kind = 'promise_told' ORDER BY created_at`);

beforeAll(async () => {
  await w.start();
  await w.bind();
  roomId = String((await w.rooms())[0]?.id);
  await seedProjectDocument(w.projectId, w.ownerId, { environments: environments(true) });
  const at = { status: 'in_progress' as const, createdAt: new Date() };
  issue.landed = (await createTestIssue(w.projectId, w.ownerId, 7, at)).id;
  issue.dropped = (await createTestIssue(w.projectId, w.ownerId, 8, at)).id;
  issue.untracked = (await createTestIssue(w.projectId, w.ownerId, 9, at)).id;
  await rows(sql`UPDATE issues SET title = ${TITLE} WHERE id = ${issue.landed}::uuid`);
  // a project of another organization, which this room does not follow
  outsider = (await createTestProject(w.ownerId)).slug;
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(PROBE)) return real(input, init);
    return new Response(JSON.stringify({ commit: served }), { status: 200 });
  });
}, 120_000);

afterAll(() => w.stop());

describe('ISS-1012: a support room promises to tell a person when an issue reaches an environment', () => {
  it("records a promise by the environment's own name, about an issue not filed from the thread (criteria 1-3)", async () => {
    const out: Record<string, unknown>[] = [];
    const thread = await onNextAsk(
      () => w.chat.say(w.chat.alice, 'Báo mình khi đơn hàng hiện ngày giao lên staging nhé'),
      async (turn, act) => {
        const asked = turn.messages.find((m) => m.from !== 'forge');
        for (const key of ['ISS-7', 'ISS-8', 'ISS-9']) {
          out.push(
            await act({
              action: 'promise',
              thread: asked?.thread,
              issue: key,
              environment: 'Staging',
              asker: (asked?.from as { id: string } | undefined)?.id,
            }),
          );
        }
        // asked again, the same promise stands: nothing new is recorded
        out.push(
          await act({
            action: 'promise',
            thread: asked?.thread,
            issue: 'ISS-7',
            environment: 'staging',
          }),
        );
        await act({ action: 'reply', thread: asked?.thread, text: 'Được, mình sẽ báo bạn ở đây.' });
      },
    );
    expect(out[0]).toMatchObject({
      promised: true,
      created: true,
      issue: { key: 'ISS-7', title: TITLE },
      environment: 'staging',
      asker: 'alice',
    });
    expect(out[3]).toMatchObject({ promised: true, created: false, promise: out[0]?.promise });
    const held = await promises();
    expect(held).toHaveLength(3);
    expect(held[0]).toMatchObject({
      issue_id: issue.landed,
      environment: 'staging',
      asker_key: w.chat.alice.userId,
      asker_label: 'alice',
      state: 'open',
      answered_at: null,
    });
    expect(Number.isNaN(Date.parse(String(held[0]?.created_at)))).toBe(false);
    // the project's master reads it on the issue
    const comments = await api(w.owner, 'GET', `/api/issues/${issue.landed}/comments`);
    expect(comments.status, JSON.stringify(comments.body)).toBe(200);
    const said = JSON.stringify(comments.body);
    expect(said).toContain('A support room promised alice');
    expect(said).toContain('reaches `staging`');
    const made = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM support_actions
       WHERE room_id = ${roomId}::uuid AND kind = 'promise_made' AND thread = ${thread}`);
    expect(made[0]?.n).toBe(3);
  });

  it('refuses by name a promise it cannot keep, when it is asked (criterion 6)', async () => {
    const out: Record<string, unknown>[] = [];
    await onNextAsk(
      () => w.chat.say(w.chat.bob, 'Còn mấy cái khác thì sao?'),
      async (turn, act) => {
        const thread = turn.messages.find((m) => m.from !== 'forge')?.thread;
        const ask = (extra: Record<string, unknown>) =>
          act({ action: 'promise', thread, issue: 'ISS-7', environment: 'staging', ...extra });
        out.push(await ask({ environment: 'qa' }));
        out.push(await ask({ environment: 'production' }));
        out.push(await ask({ project: outsider }));
        out.push(await ask({ issue: 'OUT-1' }));
        out.push(await ask({ issue: 'ISS-99' }));
        await act({ action: 'reply', thread, text: 'Mấy cái đó mình không theo dõi được.' });
      },
    );
    expect(out.map((o) => refusalCodes(o))).toEqual([
      ['SUPPORT_PROMISE_ENVIRONMENT_UNTRACKED'],
      ['SUPPORT_PROMISE_ENVIRONMENT_UNTRACKED'],
      ['SUPPORT_PROMISE_NOT_FOLLOWED'],
      ['SUPPORT_PROMISE_NOT_FOLLOWED'],
      ['SUPPORT_PROMISE_ISSUE_UNKNOWN'],
    ]);
    const said = JSON.stringify(out);
    expect(said).toContain('tracks no environment named \\"qa\\"');
    expect(said).toContain('the environments it tracks are staging, production');
    expect(said).toContain('`production` is deployed outside Forge with no source probe');
    expect(said).toContain(`project ${outsider} is not`);
    expect(await promises()).toHaveLength(3);
  });

  it('answers once when staging first serves a commit holding the landing, never twice (criterion 4)', async () => {
    await w.settleWarm();
    const notes = answersPromises();
    await rows(sql`
      UPDATE issues SET merged_at = now(), merged_commit_sha = ${LANDING}
       WHERE id = ${issue.landed}::uuid`);
    // staging serves an older build, which Forge cannot place: nothing is told
    served = OLDER;
    expect(await tellProjectPromises(w.projectId)).toBe(0);
    expect((await promises())[0]?.state).toBe('open');
    // staging now serves the landing itself
    served = LANDING;
    expect(await tellProjectPromises(w.projectId)).toBe(1);
    await expect.poll(() => notes.length, { timeout: 15_000 }).toBe(1);
    expect(notes[0]?.text).toContain(`"${TITLE}"`);
    expect(notes[0]?.text).toContain('it is on staging now');
    const lines = await w.untilLines((all) => all.some((l) => l.text.includes('đã lên staging')));
    expect(lines.filter((l) => l.text.includes('đã lên staging'))).toHaveLength(1);
    // a second watch tick, and the events' consumer, tell nothing more
    expect(await tellProjectPromises(w.projectId)).toBe(0);
    expect(await tellProjectPromises(w.projectId)).toBe(0);
    await new Promise((r) => setTimeout(r, 500));
    expect(notes).toHaveLength(1);
    const reached = (await promises())[0];
    expect(reached).toMatchObject({ state: 'reached', served_commit: LANDING });
    expect(Number.isNaN(Date.parse(String(reached?.answered_at)))).toBe(false);
    expect((await told()).map((t) => t.output.state)).toEqual(['reached']);
  });

  it('tells a promise whose issue was dropped, and one whose environment stops being tracked (criterion 5)', async () => {
    await w.settleWarm();
    const notes = answersPromises();
    // dropped through the kernel's transition, whose event the results watch also hears
    const drop = await api(w.owner, 'POST', `/api/issues/${issue.dropped}/transition`, {
      toStatus: 'dropped',
      reason: 'not work: the team will not build it',
    });
    expect(drop.status, JSON.stringify(drop.body)).toBe(200);
    await tellProjectPromises(w.projectId);
    await expect.poll(() => notes.length, { timeout: 15_000 }).toBe(1);
    expect(notes[0]?.text).toContain('the team dropped that work');
    // the project stops declaring staging: the last open promise is answered, not left silent
    await seedProjectDocument(w.projectId, w.ownerId, { environments: environments(false) });
    expect(await tellProjectPromises(w.projectId)).toBe(1);
    await expect.poll(() => notes.length, { timeout: 15_000 }).toBe(2);
    expect(notes[1]?.text).toContain('no longer tracks staging');
    expect(await tellProjectPromises(w.projectId)).toBe(0);
    expect((await promises()).map((p) => p.state)).toEqual(['reached', 'dropped', 'untracked']);
    expect((await told()).map((t) => t.output.state)).toEqual(['reached', 'dropped', 'untracked']);
  });
});
