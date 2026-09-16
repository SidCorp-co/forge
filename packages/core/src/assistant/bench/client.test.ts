/**
 * ISS-1051 — the client over a fake fetch: the paths it hits, the bearer it carries, the refusal
 * it raises on a non-2xx, and the three places a guess would have crept in — a slug that matches
 * no project or two, a lookup that errored rather than 404ed, and a trail with more than one page.
 */

import { describe, expect, it } from 'vitest';
import { createClient, DeploymentRefusal, type FetchLike } from './client.js';
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
