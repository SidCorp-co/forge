/**
 * ISS-1051 — the client over a fake fetch: the paths it hits, the bearer it carries, the refusal
 * it raises on a non-2xx, and the three places a guess would have crept in — a slug that matches
 * no project or two, a lookup that errored rather than 404ed, and a trail with more than one page.
 */

import { describe, expect, it } from 'vitest';
import { createClient, DeploymentRefusal, FetchFailure, type FetchLike } from './client.js';
import {
  createFakeDeployment,
  DEAD_ISSUE_ID,
  ERROR_ISSUE_ID,
  FAKE_ISSUE,
  FAKE_PROJECT,
  FAKE_TOKEN,
} from './fake-deployment.js';

const fake = (over: Partial<Parameters<typeof createFakeDeployment>[0]> = {}) =>
  createFakeDeployment({ script: () => ({ attempts: [{ reply: 'hi' }] }), ...over });

describe('sign-in and the bearer', () => {
  it('posts to /api/auth/local, then carries the token on every call', async () => {
    const { fetch, state } = fake();
    const client = createClient({ api: 'https://api.test/', fetch });
    await client.signIn('a@b.c', 'pw');
    await client.version();
    await client.readPreferences();
    expect(state.requests.map((r) => [r.method, r.path, r.auth])).toEqual([
      ['POST', '/api/auth/local', null],
      ['GET', '/version', `Bearer ${FAKE_TOKEN}`],
      ['GET', '/api/auth/preferences', `Bearer ${FAKE_TOKEN}`],
    ]);
  });

  it('refuses a non-2xx naming the route, the status and the body first line', async () => {
    const { fetch } = fake();
    const client = createClient({ api: 'https://api.test', fetch });
    await expect(client.readPreferences()).rejects.toThrow(
      'GET /api/auth/preferences answered 401: {"error":"unauthorized"}',
    );
    await expect(client.signIn('', '')).rejects.toBeInstanceOf(DeploymentRefusal);
  });
});

describe('lookups', () => {
  it('projectBySlug resolves one slug and refuses none or two', async () => {
    const { fetch } = fake();
    const client = createClient({ api: 'https://api.test', fetch });
    client.useToken(FAKE_TOKEN);
    expect(await client.projectBySlug('qa')).toEqual(FAKE_PROJECT);
    await expect(client.projectBySlug('nope')).rejects.toThrow('0 projects carry slug nope');
    const twice: FetchLike = async () =>
      new Response(JSON.stringify([FAKE_PROJECT, FAKE_PROJECT]), { status: 200 });
    const dup = createClient({ api: 'https://api.test', fetch: twice });
    await expect(dup.projectBySlug('qa')).rejects.toThrow('2 projects carry slug qa');
  });

  it('firstOpenIssue reads the envelope and refuses an empty project', async () => {
    const { fetch } = fake();
    const client = createClient({ api: 'https://api.test', fetch });
    client.useToken(FAKE_TOKEN);
    expect(await client.firstOpenIssue(FAKE_PROJECT.id)).toEqual({
      id: FAKE_ISSUE.id,
      key: 'ISS-7',
      title: 'Widget wobbles',
    });
    const empty = createClient({ api: 'https://api.test', fetch: fake({ issues: [] }).fetch });
    empty.useToken(FAKE_TOKEN);
    await expect(empty.firstOpenIssue(FAKE_PROJECT.id)).rejects.toThrow(
      'the project holds no open issue',
    );
  });

  it('issueExists: 200 resolves, 404 dead, anything else thrown', async () => {
    const { fetch } = fake();
    const client = createClient({ api: 'https://api.test', fetch });
    client.useToken(FAKE_TOKEN);
    expect(await client.issueExists(FAKE_ISSUE.id)).toBe('resolves');
    expect(await client.issueExists(DEAD_ISSUE_ID)).toBe('dead');
    await expect(client.issueExists(ERROR_ISSUE_ID)).rejects.toThrow(
      `GET /api/issues/${ERROR_ISSUE_ID} answered 500`,
    );
    const unauth = createClient({ api: 'https://api.test', fetch });
    await expect(unauth.issueExists(DEAD_ISSUE_ID)).rejects.toThrow('answered 401');
  });
});

describe('the project readers (ISS-1061)', () => {
  const on = (over: Partial<Parameters<typeof createFakeDeployment>[0]> = {}) => {
    const { fetch, state } = fake(over);
    const client = createClient({ api: 'https://api.test', fetch });
    client.useToken(FAKE_TOKEN);
    return { client, state };
  };

  it('issueCounts walks every page and counts by status', async () => {
    const { client, state } = on({ pageSize: 1 });
    expect(await client.issueCounts(FAKE_PROJECT.id)).toEqual({
      openCount: 1,
      closedCount: 1,
      draftCount: 0,
    });
    const pages = state.requests.filter(
      (r) => r.path === `/api/projects/${FAKE_PROJECT.id}/issues`,
    );
    expect(pages).toHaveLength(3);
  });

  it('waitingIssue reads the first needs_info issue and refuses by name where there is none', async () => {
    const { client } = on();
    expect(await client.waitingIssue(FAKE_PROJECT.id)).toMatchObject({
      key: 'ISS-9',
      id: '55555555-5555-4555-8555-555555555555',
    });
    const { client: none } = on({ issues: [FAKE_ISSUE] });
    await expect(none.waitingIssue(FAKE_PROJECT.id)).rejects.toThrow(
      'the project holds no issue waiting on information',
    );
  });

  it('pipelineStates reads the state keys in config order and refuses an empty config', async () => {
    const { client } = on({ states: ['triage', 'building', 'shipped'] });
    expect(await client.pipelineStates(FAKE_PROJECT.id)).toEqual(['triage', 'building', 'shipped']);
    const { client: empty } = on({ states: [] });
    await expect(empty.pipelineStates(FAKE_PROJECT.id)).rejects.toThrow(
      'the pipeline config names no state',
    );
  });

  it('listNotes reads every page, archived rows included, and deleteNote removes by sourceRef', async () => {
    const notes = [
      { id: 'n1', sourceRef: 'ref-1', textContent: 'live one', archivedAt: null },
      {
        id: 'n2',
        sourceRef: 'ref-2',
        textContent: 'archived one',
        archivedAt: '2026-09-01T00:00:00.000Z',
      },
      { id: 'n3', sourceRef: 'ref-3', textContent: 'live two', archivedAt: null },
    ];
    const { client, state } = on({ pageSize: 1, notes });
    expect(await client.listNotes(FAKE_PROJECT.id)).toEqual([
      { id: 'n1', sourceRef: 'ref-1', text: 'live one' },
      { id: 'n2', sourceRef: 'ref-2', text: 'archived one' },
      { id: 'n3', sourceRef: 'ref-3', text: 'live two' },
    ]);
    const lists = state.requests.filter((r) => r.path === '/api/memory');
    expect(lists).toHaveLength(3);
    expect(await client.deleteNote(FAKE_PROJECT.id, 'ref-2')).toBe(1);
    expect(await client.deleteNote(FAKE_PROJECT.id, 'ref-2')).toBe(0);
    expect(state.notes.map((n) => n.id)).toEqual(['n1', 'n3']);
  });
});

describe('a fetch that threw (ISS-1065)', () => {
  const dropped = () => Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } });

  it('retries a GET once after the delay and returns the second answer, counting the retry', async () => {
    const { fetch } = fake({
      throwOn: (method, path, count) =>
        method === 'GET' && path.startsWith('/api/projects') && count === 1 ? dropped() : null,
    });
    const client = createClient({ api: 'https://api.test', fetch, retryDelayMs: 1 });
    client.useToken(FAKE_TOKEN);
    expect((await client.projectBySlug(FAKE_PROJECT.slug)).id).toBe(FAKE_PROJECT.id);
    expect(client.retries()).toBe(1);
  });

  it('a timed-out first attempt is retried on a fresh signal, never the one already aborted', async () => {
    const { fetch: inner } = fake();
    const signals: Array<AbortSignal | null | undefined> = [];
    let first = true;
    const fetch: FetchLike = async (url, init) => {
      if (String(url).endsWith('/version')) {
        signals.push(init?.signal);
        if (first) {
          first = false;
          throw Object.assign(new Error('The operation was aborted due to timeout'), {
            name: 'TimeoutError',
          });
        }
      }
      return inner(url, init);
    };
    const client = createClient({
      api: 'https://api.test',
      fetch,
      timeoutMs: 5000,
      retryDelayMs: 1,
    });
    client.useToken(FAKE_TOKEN);
    await client.version();
    expect(client.retries()).toBe(1);
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[1]).toBeInstanceOf(AbortSignal);
    expect(signals[1]).not.toBe(signals[0]);
    expect(signals[1]?.aborted).toBe(false);
  });

  it('a GET that throws twice names the request, the cause and the first attempt', async () => {
    const { fetch } = fake({ throwOn: (method) => (method === 'GET' ? dropped() : null) });
    const client = createClient({ api: 'https://api.test', fetch, retryDelayMs: 1 });
    client.useToken(FAKE_TOKEN);
    const err = await client.version().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchFailure);
    expect((err as Error).message).toBe(
      'fetch failed (cause: ECONNRESET) on GET /version; first attempt: fetch failed (cause: ECONNRESET) on GET /version',
    );
    expect(client.retries()).toBe(1);
  });

  it('never re-sends a POST that threw: one attempt, the error names it, no retry counted', async () => {
    let posts = 0;
    const { fetch } = fake({
      throwOn: (method) => {
        if (method !== 'POST') return null;
        posts += 1;
        return dropped();
      },
    });
    const client = createClient({ api: 'https://api.test', fetch, retryDelayMs: 1 });
    client.useToken(FAKE_TOKEN);
    await expect(client.openRoom(FAKE_PROJECT.id, 'bench r1 t')).rejects.toThrow(
      'fetch failed (cause: ECONNRESET) on POST /api/conversations',
    );
    expect(posts).toBe(1);
    expect(client.retries()).toBe(0);
  });

  it('roomGone: 404 is gone, 200 and 403 are a room still standing, anything else is thrown', async () => {
    const { fetch } = fake({
      refuse: (method, path) =>
        path.endsWith('/room-forbidden') ? 403 : path.endsWith('/room-broken') ? 500 : null,
    });
    const client = createClient({ api: 'https://api.test', fetch });
    client.useToken(FAKE_TOKEN);
    const room = await client.openRoom(FAKE_PROJECT.id, 'bench r1 t');
    expect(await client.roomGone(room.id)).toBe(false);
    expect(await client.roomGone('room-none')).toBe(true);
    expect(await client.roomGone('room-forbidden')).toBe(false);
    await expect(client.roomGone('room-broken')).rejects.toThrow(DeploymentRefusal);
  });
});

describe('rooms and the trail', () => {
  it('opens, sends, reads, deletes and reads the deletion back', async () => {
    const { fetch, state } = fake();
    const client = createClient({ api: 'https://api.test', fetch });
    client.useToken(FAKE_TOKEN);
    const room = await client.openRoom(FAKE_PROJECT.id, 'bench r1 t');
    const sent = await client.send(room.id, 'hello');
    expect(sent.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hello'],
      ['assistant', 'hi'],
    ]);
    expect((await client.readRoom(room.id)).status).toBe(200);
    await client.deleteRoom(room.id);
    expect(await client.readRoom(room.id)).toEqual({ status: 404 });
    expect(state.deleted).toEqual([room.id]);
    await expect(client.deleteRoom(room.id)).rejects.toThrow('answered 404');
  });

  it('consumes every page of the trail', async () => {
    const { fetch, state } = fake({ pageSize: 2 });
    const client = createClient({ api: 'https://api.test', fetch });
    client.useToken(FAKE_TOKEN);
    const room = await client.openRoom(FAKE_PROJECT.id, 'bench r1 t');
    for (let i = 0; i < 5; i += 1) await client.send(room.id, `m${i}`);
    const rows = await client.trail<{ id: string }>({
      projectSlug: 'qa',
      dateFrom: '2026-01-01',
      dateTo: '2027-01-01',
    });
    expect(rows).toHaveLength(5);
    expect(state.requests.filter((r) => r.path === '/api/chat-logs')).toHaveLength(3);
  });

  it('preferences: read, write, and the change trail', async () => {
    const { fetch } = fake();
    const client = createClient({ api: 'https://api.test', fetch });
    client.useToken(FAKE_TOKEN);
    expect(await client.readPreferences()).toMatchObject({
      answerStyle: 'default',
      assistantInstructions: null,
    });
    await client.writePreferences({ answerStyle: 'bullets' });
    expect((await client.readPreferences()).answerStyle).toBe('bullets');
    const changes = await client.preferenceChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      field: 'answer_style',
      previousValue: 'default',
      newValue: 'bullets',
    });
  });
});
