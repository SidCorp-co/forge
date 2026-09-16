/**
 * ISS-1051 — a scripted deployment for the tests: every route the client knows, answered from
 * memory, with the assistant's turn played from a script so a test can plant a forgotten fact, a
 * dead link, a screen repair or an unmoved preference and watch the grader name it.
 */

import type { FetchLike, PreferenceChange, RoomMessage } from './client.js';
import type { ChatLogRow } from './trail.js';

export interface ScriptedAttempt {
  reply: string | null;
  toolCalls?: Array<{ name: string; arguments: string; isError?: boolean }>;
  iterations?: number;
  durationMs?: number;
  error?: string | null;
}

export interface ScriptedTurn {
  attempts: ScriptedAttempt[];
  /** The text the room delivers; defaults to the last attempt's reply. `null` delivers nothing. */
  deliver?: string | null;
  /** Preference writes the turn makes through the one writer, before the reply is delivered. */
  moves?: Array<{ answerStyle?: string; assistantInstructions?: string | null }>;
  /** Answer the send with this status after its side effects, as a crashed door would. */
  failWith?: number;
}

export type Script = (message: string, taskId: string, turnIndex: number) => ScriptedTurn;

export interface FakeIssue {
  id: string;
  displayId: string;
  title: string;
  status: string;
}

export interface FakeOptions {
  script: Script;
  project?: { id: string; slug: string; name: string };
  issues?: FakeIssue[];
  prefs?: { answerStyle: string; assistantInstructions: string | null };
  /** Return a status to refuse a request with, or null to let it through. */
  refuse?: (method: string, path: string, count: number) => number | null;
  pageSize?: number;
}

export interface FakeState {
  prefs: { answerStyle: string; assistantInstructions: string | null };
  changes: PreferenceChange[];
  chatLogs: Array<ChatLogRow & { projectSlug: string; model: string }>;
  rooms: Map<string, { title: string; projectId: string; messages: RoomMessage[]; seq: number }>;
  deleted: string[];
  requests: Array<{ method: string; path: string; auth: string | null }>;
}

export const FAKE_PROJECT = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'qa',
  name: 'QA Project',
};
export const FAKE_ISSUE: FakeIssue = {
  id: '22222222-2222-4222-8222-222222222222',
  displayId: 'ISS-7',
  title: 'Widget wobbles',
  status: 'open',
};
export const DEAD_ISSUE_ID = '33333333-3333-4333-8333-333333333333';
export const ERROR_ISSUE_ID = '44444444-4444-4444-8444-444444444444';
export const FAKE_TOKEN = 'fake-bearer';

const json = (status: number, body: unknown): Response =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

let clock = 0;
const tick = (): string => new Date(Date.UTC(2026, 8, 16, 0, 0, clock++)).toISOString();

interface Ctx {
  opts: FakeOptions;
  project: { id: string; slug: string; name: string };
  issues: FakeIssue[];
  state: FakeState;
  nextId: (prefix: string) => string;
}

function writePrefs(
  ctx: Ctx,
  patch: { answerStyle?: string; assistantInstructions?: string | null },
  conversationId: string | null,
): void {
  const { state } = ctx;
  const fields: Array<['answer_style' | 'assistant_instructions', string | null, string | null]> =
    [];
  if (patch.answerStyle !== undefined && patch.answerStyle !== state.prefs.answerStyle) {
    fields.push(['answer_style', state.prefs.answerStyle, patch.answerStyle]);
    state.prefs.answerStyle = patch.answerStyle;
  }
  if (patch.assistantInstructions !== undefined) {
    const next = patch.assistantInstructions?.trim() || null;
    if (next !== state.prefs.assistantInstructions) {
      fields.push(['assistant_instructions', state.prefs.assistantInstructions, next]);
      state.prefs.assistantInstructions = next;
    }
  }
  for (const [field, previousValue, newValue] of fields) {
    state.changes.push({
      id: ctx.nextId('chg'),
      field,
      previousValue,
      newValue,
      conversationId,
      changedAt: tick(),
    });
  }
}

function playTurn(ctx: Ctx, roomId: string, content: string): Response {
  const { state } = ctx;
  const room = state.rooms.get(roomId);
  if (!room) return json(404, { error: 'no such room' });
  const taskId = room.title.split(' ')[2] ?? '';
  const userTurns = room.messages.filter((m) => m.role === 'user').length;
  room.messages.push({
    id: ctx.nextId('msg'),
    role: 'user',
    content,
    silenceReason: null,
    createdAt: tick(),
  });
  const turn = ctx.opts.script(content, taskId, userTurns);
  for (const a of turn.attempts) {
    state.chatLogs.push({
      id: ctx.nextId('log'),
      sessionId: roomId,
      projectSlug: ctx.project.slug,
      model: 'fake-model',
      reply: a.reply,
      toolCalls: (a.toolCalls ?? []).map((c) => ({
        ...c,
        isError: c.isError ?? false,
        durationMs: 5,
        round: 1,
      })),
      iterations: a.iterations ?? 1,
      durationMs: a.durationMs ?? 100,
      error: a.error ?? null,
      createdAt: tick(),
    });
  }
  for (const move of turn.moves ?? []) writePrefs(ctx, move, roomId);
  if (turn.failWith) return json(turn.failWith, { error: 'the door crashed' });
  const deliver = turn.deliver === undefined ? (turn.attempts.at(-1)?.reply ?? null) : turn.deliver;
  if (deliver !== null)
    room.messages.push({
      id: ctx.nextId('msg'),
      role: 'assistant',
      content: deliver,
      silenceReason: null,
      createdAt: tick(),
    });
  const seq = room.seq++;
  return json(201, { seq, decision: null, messages: room.messages, windows: [] });
}

function chatLogs(ctx: Ctx, url: URL): Response {
  const slug = url.searchParams.get('projectSlug');
  const page = Number(url.searchParams.get('page') ?? '1');
  const pageSize = Math.min(
    Number(url.searchParams.get('pageSize') ?? '50'),
    ctx.opts.pageSize ?? 100,
  );
  const rows = ctx.state.chatLogs
    .filter((r) => r.projectSlug === slug)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const offset = (page - 1) * pageSize;
  const items = rows.slice(offset, offset + pageSize);
  return json(200, { items, returned: items.length, total: rows.length, limit: pageSize, offset });
}

function issueRoutes(ctx: Ctx, method: string, url: URL): Response | null {
  const path = url.pathname;
  if (method === 'GET' && path === '/api/projects')
    return json(200, [
      ctx.project,
      { id: '99999999-9999-4999-8999-999999999999', slug: 'other', name: 'Other' },
    ]);
  if (method === 'GET' && path === `/api/projects/${ctx.project.id}/issues`) {
    const status = url.searchParams.get('status');
    const items = ctx.issues
      .filter((i) => !status || i.status === status)
      .slice(0, Number(url.searchParams.get('limit') ?? '50'));
    return json(200, { items, returned: items.length, total: items.length, limit: 1, offset: 0 });
  }
  const issue = /^\/api\/issues\/([^/]+)$/.exec(path);
  if (method === 'GET' && issue) {
    if (issue[1] === ERROR_ISSUE_ID) return json(500, { error: 'boom' });
    const hit = ctx.issues.find((i) => i.id === issue[1]);
    return hit ? json(200, hit) : json(404, { error: 'no such issue' });
  }
  return null;
}

function roomRoutes(
  ctx: Ctx,
  method: string,
  path: string,
  body: Record<string, unknown>,
): Response | null {
  const { state } = ctx;
  if (method === 'POST' && path === '/api/conversations') {
    const id = ctx.nextId('room');
    state.rooms.set(id, {
      title: String(body.title),
      projectId: String(body.projectId),
      messages: [],
      seq: 0,
    });
    return json(201, { id, title: body.title, projectId: body.projectId });
  }
  const room = /^\/api\/conversations\/([^/]+)(\/messages)?$/.exec(path);
  if (!room?.[1]) return null;
  const id = room[1];
  if (method === 'POST' && room[2]) return playTurn(ctx, id, String(body.content));
  if (method === 'GET') {
    const r = state.rooms.get(id);
    return r
      ? json(200, { id, title: r.title, messages: r.messages, windows: [] })
      : json(404, { error: 'gone' });
  }
  if (method === 'DELETE') {
    if (!state.rooms.delete(id)) return json(404, { error: 'gone' });
    state.deleted.push(id);
    return json(204, null);
  }
  return null;
}

function preferenceRoutes(
  ctx: Ctx,
  method: string,
  path: string,
  body: Record<string, unknown>,
): Response | null {
  const { state } = ctx;
  if (method === 'GET' && path === '/api/auth/preferences')
    return json(200, { theme: 'light', language: 'en', ...state.prefs });
  if (method === 'PATCH' && path === '/api/auth/preferences') {
    writePrefs(ctx, body as { answerStyle?: string; assistantInstructions?: string | null }, null);
    return json(200, { theme: 'light', language: 'en', ...state.prefs });
  }
  if (method === 'GET' && path === '/api/auth/preferences/changes')
    return json(200, { items: state.changes });
  return null;
}

export function createFakeDeployment(opts: FakeOptions): { fetch: FetchLike; state: FakeState } {
  const state: FakeState = {
    prefs: { ...(opts.prefs ?? { answerStyle: 'default', assistantInstructions: null }) },
    changes: [],
    chatLogs: [],
    rooms: new Map(),
    deleted: [],
    requests: [],
  };
  let ids = 0;
  const ctx: Ctx = {
    opts,
    project: opts.project ?? FAKE_PROJECT,
    issues: opts.issues ?? [FAKE_ISSUE],
    state,
    nextId: (prefix) => `${prefix}-${String(++ids).padStart(4, '0')}`,
  };
  let count = 0;
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    const headers = init?.headers as Record<string, string> | undefined;
    const auth = headers?.authorization ?? null;
    const path = url.pathname;
    state.requests.push({ method, path, auth });
    count += 1;
    const refused = opts.refuse?.(method, path, count);
    if (refused) return json(refused, { error: `refused ${method} ${path}` });
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    if (method === 'POST' && path === '/api/auth/local')
      return body.email && body.password
        ? json(200, { token: FAKE_TOKEN })
        : json(401, { error: 'bad credentials' });
    if (method === 'GET' && path === '/version')
      return json(200, { version: '0.3.0', sourceCommit: 'abc1234' });
    if (auth !== `Bearer ${FAKE_TOKEN}`) return json(401, { error: 'unauthorized' });
    if (method === 'GET' && path === '/api/chat-logs') return chatLogs(ctx, url);
    return (
      issueRoutes(ctx, method, url) ??
      roomRoutes(ctx, method, path, body) ??
      preferenceRoutes(ctx, method, path, body) ??
      json(404, { error: `no route ${method} ${path}` })
    );
  };
  return { fetch, state };
}
