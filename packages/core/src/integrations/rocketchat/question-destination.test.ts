/**
 * ISS-1091 — where one owed round goes, and every way it goes nowhere.
 *
 * What these cases are really about is the absence of one branch: there is no
 * path from a conversation-origin round to `roomForProject`. Every assertion
 * below that expects `unresolvable` would have been a post into the project's
 * bound room before this change, which is the defect the issue names.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuestionOrigin, QuestionStep } from '../../db/schema-questions.js';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const connections = vi.fn<() => unknown[]>(() => []);
const bindings = vi.fn<() => unknown[]>(() => []);
let selectCall = 0;
vi.mock('../../db/client.js', () => {
  const chain = {
    where: () => chain,
    then: (resolve: (v: unknown) => unknown) =>
      // `connectionBinding` reads connections then bindings, and a sensitive round runs it twice —
      // once for the origin room and once for the direct room — so the answers alternate rather
      // than switching after the first.
      Promise.resolve(selectCall++ % 2 === 0 ? connections() : bindings()).then(resolve),
  };
  return { db: { select: () => ({ from: () => chain }) } };
});

const questionThread = vi.fn<() => Promise<unknown>>(async () => null);
vi.mock('./thread-registry.js', () => ({ questionThread: () => questionThread() }));

const roomForProject = vi.fn<() => Promise<unknown>>(async () => null);
vi.mock('./project-room.js', () => ({ roomForProject: () => roomForProject() }));

const resolveRoomPostAuth = vi.fn<() => Promise<unknown>>(async () => ({
  serverUrl: 'https://chat.example.co',
  authToken: 't',
  userId: 'bot',
}));
vi.mock('./room-delivery.js', () => ({ resolveRoomPostAuth: () => resolveRoomPostAuth() }));

const directRoomFor = vi.fn<() => Promise<unknown>>(async () => ({ ok: true, rid: 'DM1' }));
vi.mock('./direct-room.js', () => ({ directRoomFor: () => directRoomFor() }));

const { isUnreachableRoom, resolveQuestionDestination } = await import('./question-destination.js');

const step = (over: Partial<QuestionStep> = {}): QuestionStep =>
  ({
    round: 1,
    prompt: 'which?',
    askedAt: '2026-09-17T00:00:00.000Z',
    answerShape: 'free_text',
    needed: 'the token',
    ...over,
  }) as QuestionStep;

const conversationOrigin = (
  over: Partial<Extract<QuestionOrigin, { kind: 'conversation' }>> = {},
) =>
  ({
    kind: 'conversation',
    adapter: 'rocketchat',
    venueId: 'chat.example.co ROOMA',
    conversationId: 'c-1',
    windowId: 'w-1',
    anchorId: 'm-9',
    askedByUserId: 'u-9',
    askedByLabel: 'dao',
    askedByKey: 'rc-9',
    ...over,
  }) as QuestionOrigin;

const bindRoom = (...rids: string[]) => {
  connections.mockReturnValue([{ id: 'conn-1', config: { serverUrl: 'https://chat.example.co' } }]);
  bindings.mockReturnValue([{ connectionId: 'conn-1', config: { rids } }]);
};

const resolve = (origin: QuestionOrigin | null, s: QuestionStep = step()) =>
  resolveQuestionDestination({ questionId: 'q-1', projectId: 'p-1', origin, step: s });

beforeEach(() => {
  selectCall = 0;
  connections.mockReturnValue([]);
  bindings.mockReturnValue([]);
  questionThread.mockResolvedValue(null);
  roomForProject.mockResolvedValue(null);
  directRoomFor.mockResolvedValue({ ok: true, rid: 'DM1' });
  resolveRoomPostAuth.mockResolvedValue({
    serverUrl: 'https://chat.example.co',
    authToken: 't',
    userId: 'bot',
  });
});

describe('resolveQuestionDestination', () => {
  it('sends a question with no origin to the project room, as it always did', async () => {
    roomForProject.mockResolvedValue({ connectionId: 'conn-p', rid: 'PROJ' });
    expect(await resolve(null)).toEqual({
      kind: 'room',
      connectionId: 'conn-p',
      rid: 'PROJ',
      tmid: null,
      takeAnchor: false,
    });
  });

  it('refuses a question with no origin and no bound room', async () => {
    const d = await resolve(null);
    expect(d.kind).toBe('unresolvable');
  });

  it('sends a conversation question to the room it was asked in, anchored on the message', async () => {
    bindRoom('ROOMA');
    expect(await resolve(conversationOrigin())).toEqual({
      kind: 'room',
      connectionId: 'conn-1',
      rid: 'ROOMA',
      tmid: 'm-9',
      takeAnchor: true,
    });
  });

  it('opens its own thread where the window message carried no transport id', async () => {
    bindRoom('ROOMA');
    const d = await resolve(conversationOrigin({ anchorId: null }));
    expect(d).toMatchObject({ kind: 'room', rid: 'ROOMA', tmid: null, takeAnchor: false });
  });

  it('refuses an unresolved origin and never reaches the project room', async () => {
    roomForProject.mockResolvedValue({ connectionId: 'conn-p', rid: 'PROJ' });
    const d = await resolve({ kind: 'unresolved', reason: 'the venue could not be read' });
    expect(d).toEqual({ kind: 'unresolvable', reason: 'the venue could not be read' });
    expect(roomForProject).not.toHaveBeenCalled();
  });

  it('refuses an origin on an adapter this lane cannot post to, naming it', async () => {
    roomForProject.mockResolvedValue({ connectionId: 'conn-p', rid: 'PROJ' });
    const d = await resolve(conversationOrigin({ adapter: 'web' }));
    expect(d.kind === 'unresolvable' && d.reason).toContain('web');
    expect(roomForProject).not.toHaveBeenCalled();
  });

  it('refuses a venue that is itself a thread, because threads do not nest', async () => {
    const d = await resolve(conversationOrigin({ venueId: 'chat.example.co ROOMA THREAD1' }));
    expect(d.kind === 'unresolvable' && d.reason).toContain('THREAD1');
  });

  it('refuses a room no active connection binds under this project', async () => {
    roomForProject.mockResolvedValue({ connectionId: 'conn-p', rid: 'PROJ' });
    const d = await resolve(conversationOrigin());
    expect(d.kind === 'unresolvable' && d.reason).toContain('ROOMA');
    expect(roomForProject).not.toHaveBeenCalled();
  });

  it('sends a sensitive round to the direct room, with no anchor in the public one', async () => {
    bindRoom('ROOMA', 'DM1');
    expect(await resolve(conversationOrigin(), step({ sensitive: true }))).toEqual({
      kind: 'room',
      connectionId: 'conn-1',
      rid: 'DM1',
      tmid: null,
      takeAnchor: false,
    });
  });

  it('refuses a sensitive round whose asker has no direct room, rather than posting in the open', async () => {
    bindRoom('ROOMA', 'DM1');
    directRoomFor.mockResolvedValue({ ok: false, reason: 'no account to send it to' });
    const d = await resolve(conversationOrigin(), step({ sensitive: true }));
    expect(d).toEqual({ kind: 'unresolvable', reason: 'no account to send it to' });
  });

  it('refuses a sensitive round whose direct room no binding names, naming the way out', async () => {
    bindRoom('ROOMA');
    const d = await resolve(conversationOrigin(), step({ sensitive: true }));
    expect(d.kind).toBe('unresolvable');
    expect(d.kind === 'unresolvable' && d.reason).toContain('DM1');
    expect(d.kind === 'unresolvable' && d.reason).toContain('Bind that room');
  });

  it('posts a follow-up into the thread its first round opened', async () => {
    questionThread.mockResolvedValue({ connectionId: 'conn-1', rid: 'ROOMA', tmid: 'm-9' });
    expect(await resolve(conversationOrigin(), step({ round: 2 }))).toEqual({
      kind: 'room',
      connectionId: 'conn-1',
      rid: 'ROOMA',
      tmid: 'm-9',
      takeAnchor: false,
    });
  });

  it('refuses a sensitive follow-up on a question already threaded in the open', async () => {
    questionThread.mockResolvedValue({ connectionId: 'conn-1', rid: 'ROOMA', tmid: 'm-9' });
    const d = await resolve(conversationOrigin(), step({ round: 2, sensitive: true }));
    expect(d.kind === 'unresolvable' && d.reason).toContain('one decision is one thread');
  });

  it('keeps a sensitive follow-up in a thread that is already the direct room', async () => {
    questionThread.mockResolvedValue({ connectionId: 'conn-1', rid: 'DM1', tmid: 'root' });
    expect(await resolve(conversationOrigin(), step({ round: 2, sensitive: true }))).toMatchObject({
      kind: 'room',
      rid: 'DM1',
      tmid: 'root',
    });
  });
});

describe('isUnreachableRoom', () => {
  it.each([
    ['chat.postMessage rejected: error-not-allowed', true],
    ['chat.postMessage failed with status 403', true],
    ['chat.postMessage failed with status 404', true],
    ['chat.postMessage rejected: error-room-not-found', true],
    ['chat.postMessage failed with status 500', false],
    ['fetch failed', false],
    ['error-not-allowed', false],
  ])('%s -> %s', (message, unreachable) => {
    expect(isUnreachableRoom(new Error(message))).toBe(unreachable);
  });
});
