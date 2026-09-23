// The question door only: that the body a box actually sends is accepted, and
// that what core stores from it is what the box asked.
//
// The runner and core do not import each other, so "the exact body the runner
// sends" needs a third thing both read — `assets/question-ask-wire.jsonl`,
// which the runner's own suite asserts it puts on the wire. A field renamed on
// one side and not the other fails here and there, rather than on a box where
// the question silently never appears (ISS-1210).
//
// `pool-routes.test.ts` is the rest of this route module and may not exceed 500
// lines, which is why this family has a file of its own.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const WIRE_FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../runner/crates/forge-runner-core/assets/question-ask-wire.jsonl',
);

/** The bodies the runner's `question ask` puts on the wire, in the order it pins them. */
const wire = readFileSync(WIRE_FIXTURE, 'utf8')
  .split('\n')
  .filter((l) => l.trim().length > 0);

const FREE_TEXT = wire[0] as string;
const CHOICE = wire[1] as string;

vi.mock('../config/env.js', () => ({
  env: { DEVICE_TOKEN_PEPPER: 'y'.repeat(32), NODE_ENV: 'test' },
}));

vi.mock('../auth/device-credential.js', () => ({
  verifyDeviceCredential: async (t: string) =>
    t === 'good' ? { id: 'dev-1', ownerId: 'u-1', status: 'online' } : null,
}));

const askQuestion = vi.fn(async (_input: unknown) => ({ id: 'q-stored' }));
const registerWaiter = vi.fn(async (_args: unknown) => undefined);
const answerOf = vi.fn(async (_id: string) => null as unknown);
const waiterFor = vi.fn(async (_args: unknown) => null as unknown);
const assertDeviceBoundToProject = vi.fn(async (_d: string, _p: string) => undefined);

class QuestionRefused extends Error {
  readonly code: string;
  constructor(message: string, code = 'QUESTION_REFUSED') {
    super(message);
    this.code = code;
  }
}

vi.mock('../questions/write.js', () => ({
  askQuestion: (i: unknown) => askQuestion(i),
  QuestionRefused,
}));
vi.mock('../questions/read.js', () => ({
  answerOf: (i: string) => answerOf(i),
  registerWaiter: (a: unknown) => registerWaiter(a),
  waiterFor: (a: unknown) => waiterFor(a),
}));
vi.mock('./device-project.js', () => ({
  assertDeviceBoundToProject: (d: string, p: string) => assertDeviceBoundToProject(d, p),
}));

vi.mock('./pool.js', () => ({ readPool: vi.fn(async () => []) }));
vi.mock('./admissible.js', () => ({ readAdmissibleIssues: vi.fn(async () => []) }));
vi.mock('../issues/issue-lease.js', () => ({
  readDeviceIssueLease: vi.fn(),
  resolveLeaseKey: vi.fn(),
}));
vi.mock('./run-session.js', () => ({
  openRunSession: vi.fn(),
  closeRunSession: vi.fn(),
  readRunSessionTerminal: vi.fn(),
  isIssueLeaseHeld: vi.fn(),
  releaseIssueLease: vi.fn(),
}));
vi.mock('./claim.js', () => ({
  claimJobForMaster: vi.fn(),
  releaseAllHeldBySession: vi.fn(),
  releaseJobFromMaster: vi.fn(),
  prepareJobForMaster: vi.fn(),
  startJobForMaster: vi.fn(),
}));
vi.mock('./master-limit.js', () => ({ recordMasterLimit: vi.fn(), clearMasterLimit: vi.fn() }));
vi.mock('./master-session.js', () => ({
  ensureMasterSession: vi.fn(),
  closeMasterSession: vi.fn(),
}));
vi.mock('./load.js', () => ({
  readDeviceLoad: vi.fn(),
  readFleetLoad: vi.fn(),
  readProjectLoad: vi.fn(),
}));

const { devicePoolRoutes } = await import('./pool-routes.js');
const { errorHandler } = await import('../middleware/error.js');

const app = new Hono();
app.route('/api/devices', devicePoolRoutes);
app.onError(errorHandler as unknown as Parameters<typeof app.onError>[0]);

const AUTH = { Authorization: 'Bearer good', 'content-type': 'application/json' };

const post = (body: string) =>
  app.request('/api/devices/me/questions', { method: 'POST', headers: AUTH, body });

beforeEach(() => {
  askQuestion.mockReset().mockResolvedValue({ id: 'q-stored' });
  registerWaiter.mockReset().mockResolvedValue(undefined);
  answerOf.mockReset().mockResolvedValue(null);
  waiterFor.mockReset().mockResolvedValue(null);
  assertDeviceBoundToProject.mockReset().mockResolvedValue(undefined);
});

describe('POST /me/questions — the body a box actually sends', () => {
  it('takes the free-text round the runner pins, and stores what the box asked', async () => {
    const res = await post(FREE_TEXT);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ questionId: 'q-stored' });

    const sent = JSON.parse(FREE_TEXT) as Record<string, unknown>;
    expect(askQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        id: sent.id,
        projectId: sent.projectId,
        issueId: sent.issueId,
        prompt: sent.prompt,
        blockerKind: sent.blockerKind,
        answer: { shape: 'free_text', needed: sent.needed },
      }),
    );
  });

  it('takes the choice round the runner pins, with its options and its recommendation', async () => {
    const res = await post(CHOICE);
    expect(res.status).toBe(200);

    const sent = JSON.parse(CHOICE) as Record<string, unknown>;
    expect(askQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: sent.prompt,
        blockerKind: sent.blockerKind,
        sensitive: true,
        answer: {
          shape: 'choice',
          options: sent.options,
          recommendedOptionId: sent.recommendedOptionId,
        },
      }),
    );
  });

  it('carries no issue when the box sent none, which is what puts it on the Questions tab', async () => {
    await post(CHOICE);
    const [input] = askQuestion.mock.calls[0] as [Record<string, unknown>];
    expect(input.issueId).toBeUndefined();
  });

  it('registers this box as the waiter under the run the ask carried', async () => {
    await post(FREE_TEXT);
    const sent = JSON.parse(FREE_TEXT) as Record<string, unknown>;
    expect(registerWaiter).toHaveBeenCalledWith({
      questionId: 'q-stored',
      deviceId: 'dev-1',
      runId: sent.runId,
    });
  });

  it('refuses a box asking under a project it is not bound to, and writes nothing', async () => {
    assertDeviceBoundToProject.mockRejectedValue(
      new HTTPException(403, {
        message: 'device not bound to project',
        cause: { code: 'FORBIDDEN' },
      }),
    );
    const res = await post(FREE_TEXT);
    expect(res.status).toBe(403);
    expect(askQuestion).not.toHaveBeenCalled();
  });

  it('hands a question core refused back on 400 with the refusal core wrote', async () => {
    askQuestion.mockRejectedValue(
      new QuestionRefused(
        'a question with no options is not a question',
        'QUESTION_OPTIONS_REQUIRED',
      ),
    );
    const res = await post(CHOICE);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('not a question');
  });

  it('401s a box with no device token, so nothing is asked on an unaccepted credential', async () => {
    const res = await app.request('/api/devices/me/questions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: FREE_TEXT,
    });
    expect(res.status).toBe(401);
    expect(askQuestion).not.toHaveBeenCalled();
  });
});

describe('GET /me/questions/:id — the read-back', () => {
  it('serves the answer to the box registered as the waiter under that run', async () => {
    waiterFor.mockResolvedValue({ id: 'w-1' });
    answerOf.mockResolvedValue({ questionId: 'q-1', optionId: 'keep' });
    const res = await app.request('/api/devices/me/questions/q-1?runId=run-7', { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ answer: { questionId: 'q-1', optionId: 'keep' } });
    expect(waiterFor).toHaveBeenCalledWith({
      questionId: 'q-1',
      deviceId: 'dev-1',
      runId: 'run-7',
    });
  });

  it('404s a box that registered no waiter, rather than answering `not answered yet`', async () => {
    waiterFor.mockResolvedValue(null);
    const res = await app.request('/api/devices/me/questions/q-1?runId=run-7', { headers: AUTH });
    expect(res.status).toBe(404);
    expect(answerOf).not.toHaveBeenCalled();
  });
});
