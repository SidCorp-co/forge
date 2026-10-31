// The steward's doors (REQ-48 BC-1, BC-12): an item's runs, its acts, and the undo of one act, which a
// holder of project.write asks for and the steward account executes.

import { REASON_SENTENCE_MAX } from '@forge/contracts/comments';
import { STEWARD_MERGE_SHARES_MAX } from '@forge/contracts/steward';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { invalid, noQuery, zValidator } from '../middleware/zod-validator.js';
import { undoAct } from './acts-store.js';
import { askStewardDecision } from './decision-ask.js';
import { finishStewardJob } from './job.js';
import { readStewardActs, readStewardBudget, readStewardRuns } from './read.js';

export const stewardRoutes = new Hono<{ Variables: AuthVars }>();

for (const path of [
  '/:id/steward-runs',
  '/:id/steward-runs/*',
  '/:id/steward-acts',
  '/:id/steward-acts/*',
  '/:id/steward-budget',
]) {
  stewardRoutes.use(path, requireAuth(), assertEmailVerified());
}

const runsQuery = zValidator(
  'query',
  z.strictObject({ subject: z.string().regex(/^[A-Za-z][A-Za-z0-9]*-\d+$/) }),
  invalid('the item is named by its key: `?subject=REQ-n`, `FB-n` or an issue key like `ISS-n`'),
);

const projectParam = zValidator(
  'param',
  z.object({ id: z.uuid() }),
  invalid('invalid path: the project id is a uuid'),
);

const runParam = zValidator(
  'param',
  z.object({ id: z.uuid(), runId: z.uuid() }),
  invalid('invalid path: a project uuid and a steward run uuid'),
);

const doneBody = zValidator(
  'json',
  z.strictObject({
    refused: z.array(z.string().trim().min(3).max(600)).max(20),
    broken: z.array(z.string().trim().min(3).max(600)).max(20).default([]),
  }),
  invalid(
    'invalid body: { refused: ["METHOD path: CODE detail", ...], broken?: [...] }, both empty where every write landed',
  ),
);

const decisionBody = zValidator(
  'json',
  z.strictObject({
    about: z
      .string()
      .trim()
      .regex(/^[A-Za-z][A-Za-z0-9]*-\d+$/),
    prompt: z.string().trim().min(1).max(2000),
    options: z
      .array(
        z.strictObject({
          id: z.string().trim().min(1).max(100),
          label: z.string().trim().min(1).max(200),
          shares: z.string().trim().min(1).max(STEWARD_MERGE_SHARES_MAX).optional(),
        }),
      )
      .min(2)
      .max(8),
    recommendedOptionId: z.string().trim().min(1).max(100),
    why: z.string().trim().min(1).max(REASON_SENTENCE_MAX),
    basis: z.string().trim().min(1).max(400),
    serious: z.boolean().optional(),
  }),
  invalid(
    'invalid body: { about: "ISS-n" | "REQ-n" | "FB-n", prompt, options: [{ id, label, shares? }, ...], recommendedOptionId, why, basis, serious? }',
  ),
);

const actParam = zValidator(
  'param',
  z.object({ id: z.uuid(), actId: z.uuid() }),
  invalid('invalid path: a project uuid and a steward act uuid'),
);

stewardRoutes.get('/:id/steward-runs', projectParam, runsQuery, async (c) =>
  c.json(
    await readStewardRuns({
      projectId: c.req.valid('param').id,
      userId: c.get('userId'),
      subjectKey: c.req.valid('query').subject,
    }),
  ),
);

stewardRoutes.get('/:id/steward-acts', projectParam, runsQuery, async (c) =>
  c.json(
    await readStewardActs({
      projectId: c.req.valid('param').id,
      userId: c.get('userId'),
      subjectKey: c.req.valid('query').subject,
    }),
  ),
);

stewardRoutes.get('/:id/steward-budget', projectParam, noQuery, async (c) =>
  c.json(await readStewardBudget({ projectId: c.req.valid('param').id, userId: c.get('userId') })),
);

stewardRoutes.post('/:id/steward-acts/:actId/undo', actParam, async (c) => {
  const { id, actId } = c.req.valid('param');
  const outcome = await undoAct({
    projectId: id,
    actId,
    userId: c.get('userId'),
  });
  if (!outcome.ok) {
    // the inverse door refused: answered as it answered, so its refusal names what was wrong
    return c.body(outcome.answer.text, outcome.answer.status as ContentfulStatusCode, {
      'content-type': 'application/json',
    });
  }
  return c.json({ act: outcome.act, undone: outcome.undone });
});

// the one decision question a steward run asks about a stuck item (REQ-48 BC-5)
stewardRoutes.post('/:id/steward-runs/:runId/decisions', runParam, decisionBody, async (c) => {
  const { id, runId } = c.req.valid('param');
  const asked = await askStewardDecision({
    projectId: id,
    runId,
    userId: c.get('userId'),
    ...c.req.valid('json'),
  });
  return c.json(asked, 201);
});

// a steward job's last act: its acts are over, and these writes were refused (REQ-48 BC-1)
stewardRoutes.post('/:id/steward-runs/:runId/done', runParam, doneBody, async (c) => {
  const { id, runId } = c.req.valid('param');
  const state = await finishStewardJob({
    projectId: id,
    runId,
    userId: c.get('userId'),
    refused: c.req.valid('json').refused,
    broken: c.req.valid('json').broken,
  });
  return c.json({ state });
});
