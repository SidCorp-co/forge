// `about` takes one shape at both ask doors, and anything else is refused by that name: a bare
// "REQ-n" answered "Invalid input" at /about teaches nobody what to send instead (ISS-389).

import { QUESTION_ABOUT_SHAPE_SENTENCE } from '@forge/contracts/questions';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../middleware/error.js';

const state = vi.hoisted(() => ({ asked: [] as Record<string, unknown>[] }));

vi.mock('../middleware/auth.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../middleware/auth.js')>();
  return {
    ...real,
    requireAuth:
      () => async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
        c.set('userId', 'u1');
        c.set('agency', 'agent');
        c.set('principal', 'pat');
        await next();
      },
    assertEmailVerified: () => async (_c: unknown, next: () => Promise<void>) => next(),
  };
});
vi.mock('../middleware/require-device.js', () => ({
  requireDevice:
    () => async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('device', { id: 'd1' });
      await next();
    },
}));
vi.mock('../devices/device-project.js', () => ({ assertDeviceBoundToProject: async () => {} }));
vi.mock('../devices/ports.js', () => ({
  devicesPorts: () => ({
    questions: {
      askQuestion: async (input: Record<string, unknown>) => {
        state.asked.push(input);
        return { id: 'q1' };
      },
    },
  }),
}));
vi.mock('./read.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  askAs: async (input: Record<string, unknown>) => {
    state.asked.push(input);
    return { id: 'q1' };
  },
}));

const { questionRoutes } = await import('./routes.js');
const { devicePoolRoutes } = await import('../devices/pool-routes.js');

const ISSUE = '00000000-0000-4000-8000-000000000001';
const PROJECT = '00000000-0000-4000-8000-000000000002';

type Row = { code: string; path: string; detail: string };
type Answer = { status: number; code: string; detail: string; rows: Row[] };

async function post(app: Hono, path: string, body: unknown): Promise<Answer> {
  app.onError(errorHandler as never);
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const out = (await res.json()) as { code: string; detail: string; error: { refusals: Row[] } };
  return { status: res.status, code: out.code, detail: out.detail, rows: out.error?.refusals };
}

const web = (about: unknown, extra: Record<string, unknown> = {}) =>
  post(new Hono().route('/api/questions', questionRoutes), '/api/questions', {
    issueId: ISSUE,
    prompt: 'Which rule holds?',
    options: [],
    recommendedOptionId: 'a',
    about,
    ...extra,
  });

const device = (about: unknown) =>
  post(new Hono().route('/api/devices', devicePoolRoutes), '/api/devices/me/questions', {
    id: 'q-1',
    projectId: PROJECT,
    issueId: ISSUE,
    prompt: 'Which rule holds?',
    about,
  });

beforeEach(() => {
  state.asked = [];
});

const DOORS = [
  ['POST /api/questions', web],
  ['POST /api/devices/me/questions', device],
] as const;

describe('`about` in any shape but its own is refused QUESTION_ABOUT_SHAPE', () => {
  it.each(DOORS)(
    '%s refuses the bare string "REQ-5" by name, with the shape to send',
    async (_door, ask) => {
      const res = await ask('REQ-5');
      expect(res.status).toBe(400);
      expect(res.code).toBe('QUESTION_ABOUT_SHAPE');
      expect(res.rows).toEqual([
        {
          code: 'QUESTION_ABOUT_SHAPE',
          path: '/about',
          detail: `\`about\` is the bare string "REQ-5". ${QUESTION_ABOUT_SHAPE_SENTENCE}`,
        },
      ]);
      expect(res.detail).toContain('{"requirement":"REQ-n"}');
      expect(state.asked).toEqual([]);
    },
  );

  it.each([
    ['a misnamed key', { requirementKey: 'REQ-5' }, 'the object {"requirementKey":"REQ-5"}'],
    ['a number', 5, 'the number 5'],
    ['null', null, 'null'],
    ['an array', ['REQ-5'], 'the array ["REQ-5"]'],
    ['both keys at once', { requirement: 'REQ-5', contract: 'a/b' }, 'the object'],
    ['a contract outside <project>/<contract>', { contract: 'Billing' }, '{"contract":"Billing"}'],
    ['an empty requirement', { requirement: '' }, '{"requirement":""}'],
  ])('refuses %s, naming what was sent', async (_what, about, sent) => {
    const res = await web(about);
    expect(res.status).toBe(400);
    expect(res.code).toBe('QUESTION_ABOUT_SHAPE');
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]?.path).toBe('/about');
    expect(res.rows[0]?.detail).toContain(sent);
    expect(state.asked).toEqual([]);
  });

  it('names a wrong `about` beside every other fault of the body, under BAD_REQUEST', async () => {
    const res = await web('REQ-5', { prompt: '' });
    expect(res.status).toBe(400);
    expect(res.code).toBe('BAD_REQUEST');
    expect(res.rows.map((r) => [r.code, r.path])).toEqual([
      ['QUESTION_ABOUT_SHAPE', '/about'],
      ['BAD_REQUEST', '/prompt'],
    ]);
  });

  it('leaves a body whose `about` is right to the shared refusal', async () => {
    const res = await web({ requirement: 'REQ-5' }, { prompt: '' });
    expect(res.code).toBe('BAD_REQUEST');
    expect(res.rows.map((r) => r.path)).toEqual(['/prompt']);
  });
});

describe('`about` in its own shape is taken as sent', () => {
  it.each([{ requirement: 'REQ-5' }, { requirement: null }, { contract: 'billing/invoices' }])(
    '%j reaches the ask at both doors',
    async (about) => {
      expect((await web(about)).status).toBe(201);
      expect((await device(about)).status).toBe(200);
      expect(state.asked.map((a) => a.about)).toEqual([about, about]);
    },
  );

  it('an ask with no `about` is not refused for it', async () => {
    expect((await web(undefined)).status).toBe(201);
  });
});
