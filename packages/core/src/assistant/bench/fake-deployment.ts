/**
 * ISS-1051 — a scripted deployment for the tests: every route the client knows, answered from
 * memory, with the assistant's turn played from a script so a test can plant a forgotten fact, a
 * dead link, a screen repair or an unmoved preference and watch the grader name it.
 */

import type { FetchLike, PreferenceChange, RoomMessage } from './client.js';
import { briefRoutes } from './fake-brief-routes.js';
import { ASKED_HEADER, CALLS_HEADER, NO_REPLY, REPLIED_HEADER } from './judge.js';
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
  /** Memory notes the turn writes, as `forge_memory_note` would (sourceRef `conversation:<roomId>:<id>`); the script reads the token from the message. */
  notes?: string[];
  /** Notes somebody else writes to the project during the turn, under another room's sourceRef; never the trial's to delete. */
  foreignNotes?: string[];
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
  /** Return an error to throw from fetch itself (no response), as a dropped connection would, or null. */
  throwOn?: (method: string, path: string, count: number) => Error | null;
  pageSize?: number;
  /** Rows the window already holds before any room is opened, for the history verb's tests. */
  rows?: FakeState['chatLogs'];
  /** The judge endpoint's answer: the text the model returns, or an HTTP status to refuse with. */
  judge?: (input: { query: string; reply: string | null; model: string }) => string | number;
  /** The stage keys the project's stored config names; defaults to the one key nearly every project holds. */
  states?: string[];
  /** Stage keys the project switched off, which is the one override a project has over the ladder (ISS-1066). */
  statesOff?: string[];
  /** ISS-606 — on, a filing is parked at `draft` for a person to admit; the brief says which. */
  intakeGate?: boolean;
  /** The project's own row, as `GET /api/projects/:id` serves it and the list route does not. */
  detail?: { description?: string | null; issuePrefix?: string | null };
  /** The author's kebab-key map, which ISS-1048 is moving into knowledge entries. */
  projectFacts?: Record<string, string>;
  /** The knowledge index and the body each entry's own route serves. */
  knowledge?: Array<{
    slug: string;
    title: string;
    kind: string;
    injection: string;
    body?: string;
  }>;
  /** Refuse the knowledge index with this status, as a credential without membership would. */
  knowledgeStatus?: number;
  /** Cut the UNFILTERED knowledge index to this many rows, as the route's 38,000-character response cap does. */
  knowledgeIndexCap?: number;
  /** Memory notes the project holds before any trial. */
  notes?: FakeNote[];
}

export interface FakeNote {
  id: string;
  sourceRef: string;
  textContent: string;
  archivedAt: string | null;
}

export interface FakeCtx {
  opts: FakeOptions;
  project: { id: string; slug: string; name: string };
}

export interface FakeState {
  prefs: { answerStyle: string; assistantInstructions: string | null };
  changes: PreferenceChange[];
  chatLogs: Array<
    ChatLogRow & { projectSlug: string; model: string; query: string; source: string }
  >;
  rooms: Map<string, { title: string; projectId: string; messages: RoomMessage[]; seq: number }>;
  deleted: string[];
  notes: FakeNote[];
  /** Every judge call's system and user text, so a test reads the rubric and reference the judge saw. */
  judgeCalls: Array<{ model: string; system: string; user: string }>;
  requests: Array<{ method: string; path: string; auth: string | null; model?: string }>;
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
/** Waiting on information, so the `waitingIssue` fixture has one to read. */
export const FAKE_WAITING: FakeIssue = {
  id: '55555555-5555-4555-8555-555555555555',
  displayId: 'ISS-9',
  title: 'Needs a repro',
  status: 'needs_info',
};
export const FAKE_CLOSED: FakeIssue = {
  id: '66666666-6666-4666-8666-666666666666',
  displayId: 'ISS-8',
  title: 'Shipped already',
  status: 'closed',
};
export const DEAD_ISSUE_ID = '33333333-3333-4333-8333-333333333333';
export const ERROR_ISSUE_ID = '44444444-4444-4444-8444-444444444444';
export const FAKE_TOKEN = 'fake-bearer';
export const JUDGE_URL = 'https://judge.test';
export const JUDGE_KEY = 'judge-key';

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
      query: content,
      source: 'web-chat-reply',
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
  for (const text of turn.notes ?? [])
    state.notes.push({
      id: ctx.nextId('note'),
      sourceRef: `conversation:${roomId}:${ctx.nextId('ref')}`,
      textContent: text,
      archivedAt: null,
    });
  for (const text of turn.foreignNotes ?? [])
    state.notes.push({
      id: ctx.nextId('note'),
      sourceRef: `conversation:someone-elses-room:${ctx.nextId('ref')}`,
      textContent: text,
      archivedAt: null,
    });
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
  const source = url.searchParams.get('source');
  const page = Number(url.searchParams.get('page') ?? '1');
  const pageSize = Math.min(
    Number(url.searchParams.get('pageSize') ?? '50'),
    ctx.opts.pageSize ?? 100,
  );
  const rows = ctx.state.chatLogs
    .filter((r) => r.projectSlug === slug && (!source || r.source === source))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const offset = (page - 1) * pageSize;
  const items = rows.slice(offset, offset + pageSize);
  return json(200, { items, returned: items.length, total: rows.length, limit: pageSize, offset });
}

/** A `listResponse` envelope over `rows` at the url's limit and offset, the page never wider than `cap`. */
function page<T>(rows: T[], url: URL, cap = 100): Response {
  const limit = Math.min(Number(url.searchParams.get('limit') ?? '50'), cap);
  const offset = Number(url.searchParams.get('offset') ?? '0');
  const items = rows.slice(offset, offset + limit);
  return json(200, { items, returned: items.length, total: rows.length, limit, offset });
}

function memoryRoutes(ctx: Ctx, method: string, url: URL): Response | null {
  const { state } = ctx;
  const path = url.pathname;
  if (method === 'GET' && path === '/api/memory') {
    if (url.searchParams.get('projectId') !== ctx.project.id)
      return json(403, { error: 'not your project' });
    if (url.searchParams.get('source') !== 'note')
      return json(400, { error: 'source must be a memory source' });
    const archived = url.searchParams.get('includeArchived') === 'true';
    const rows = state.notes.filter((n) => archived || n.archivedAt === null);
    return page(rows, url, ctx.opts.pageSize);
  }
  if (method === 'DELETE' && path === '/api/memory/by-source') {
    const ref = url.searchParams.get('sourceRef');
    if (url.searchParams.get('projectId') !== ctx.project.id || !ref)
      return json(400, { error: 'projectId, source and sourceRef are required' });
    const before = state.notes.length;
    state.notes = state.notes.filter((n) => n.sourceRef !== ref);
    return json(200, { deleted: before - state.notes.length });
  }
  return null;
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
    return page(
      ctx.issues.filter((i) => !status || i.status === status),
      url,
      ctx.opts.pageSize,
    );
  }
  if (method === 'GET' && path === `/api/projects/${ctx.project.id}/pipeline-config`) {
    // cm:why the default is `open` alone: that is what nearly every project stores, and reading its
    // keys as the project's whole pipeline is the ISS-1066 defect — a default of three would have
    // let the fixture look right in every test while being wrong in the field.
    const states: Record<string, { enabled?: boolean }> = Object.fromEntries(
      (ctx.opts.states ?? ['open']).map((s) => [s, {}]),
    );
    for (const off of ctx.opts.statesOff ?? []) states[off] = { enabled: false };
    return json(200, {
      pipelineConfig: {
        enabled: true,
        states,
        ...(ctx.opts.intakeGate ? { intakeGate: { enabled: true } } : {}),
      },
    });
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

/** The judge's user message read back into the query and the reply the test scripted. */
function judgeInputOf(messages: Array<{ role: string; content: string }>): {
  query: string;
  reply: string | null;
} {
  const user = messages.find((m) => m.role === 'user')?.content ?? '';
  const query = user
    .slice(user.indexOf(ASKED_HEADER) + ASKED_HEADER.length, user.indexOf(CALLS_HEADER))
    .trim();
  const replied = user.slice(user.indexOf(REPLIED_HEADER) + REPLIED_HEADER.length).trim();
  return { query, reply: replied === NO_REPLY ? null : replied };
}

const sse = (text: string): Response =>
  new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );

function judgeRoute(
  ctx: Ctx,
  method: string,
  path: string,
  auth: string | null,
  body: Record<string, unknown>,
  state: FakeState,
): Response {
  if (method !== 'POST' || path !== '/v1/chat/completions')
    return json(404, { error: `no judge route ${method} ${path}` });
  if (auth !== `Bearer ${JUDGE_KEY}`) return json(401, { error: 'judge unauthorized' });
  const model = String(body.model ?? '');
  const last = state.requests.at(-1);
  if (last) last.model = model;
  const messages = (body.messages ?? []) as Array<{ role: string; content: string }>;
  state.judgeCalls.push({
    model,
    system: messages.find((m) => m.role === 'system')?.content ?? '',
    user: messages.find((m) => m.role === 'user')?.content ?? '',
  });
  if (!ctx.opts.judge) return json(404, { error: 'no judge scripted' });
  const answer = ctx.opts.judge({
    ...judgeInputOf(messages),
    model,
  });
  return typeof answer === 'number'
    ? json(answer, { error: `judge refused ${answer}` })
    : sse(answer);
}

export function createFakeDeployment(opts: FakeOptions): { fetch: FetchLike; state: FakeState } {
  const state: FakeState = {
    prefs: { ...(opts.prefs ?? { answerStyle: 'default', assistantInstructions: null }) },
    changes: [],
    chatLogs: [...(opts.rows ?? [])],
    rooms: new Map(),
    deleted: [],
    notes: [...(opts.notes ?? [])],
    judgeCalls: [],
    requests: [],
  };
  let ids = 0;
  const ctx: Ctx = {
    opts,
    project: opts.project ?? FAKE_PROJECT,
    issues: opts.issues ?? [FAKE_ISSUE, FAKE_CLOSED, FAKE_WAITING],
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
    const thrown = opts.throwOn?.(method, path, count);
    if (thrown) throw thrown;
    const refused = opts.refuse?.(method, path, count);
    if (refused) return json(refused, { error: `refused ${method} ${path}` });
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    if (method === 'POST' && path === '/api/auth/local')
      return body.email && body.password
        ? json(200, { token: FAKE_TOKEN })
        : json(401, { error: 'bad credentials' });
    if (method === 'GET' && path === '/version')
      return json(200, { version: '0.3.0', sourceCommit: 'abc1234' });
    if (url.origin === JUDGE_URL) return judgeRoute(ctx, method, path, auth, body, state);
    if (auth !== `Bearer ${FAKE_TOKEN}`) return json(401, { error: 'unauthorized' });
    if (method === 'GET' && path === '/api/chat-logs') return chatLogs(ctx, url);
    return (
      briefRoutes(ctx, method, url, json) ??
      issueRoutes(ctx, method, url) ??
      memoryRoutes(ctx, method, url) ??
      roomRoutes(ctx, method, path, body) ??
      preferenceRoutes(ctx, method, path, body) ??
      json(404, { error: `no route ${method} ${path}` })
    );
  };
  return { fetch, state };
}
