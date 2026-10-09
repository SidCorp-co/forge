import { FEEDBACK_TRIAGE_CHECKLIST } from '@forge/contracts/checklist-registry';
import { checklistFormOf, countsAsPassed, evaluateChecklist } from '@forge/contracts/checklists';
import { FEEDBACK_MACHINE } from '@forge/contracts/feedback-machine';
import { triageAnswersInput } from '@forge/contracts/feedback-triage';
import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { gatedMovesOf } from '../lifecycle/index.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { feedbackTriageRecord } from './checklist-record.js';
import { detailAs } from './read.js';

export const feedbackChecklistRoutes = new Hono<{ Variables: AuthVars }>();

feedbackChecklistRoutes.use('*', requireAuth(), assertEmailVerified());

/**
 * `GET /api/projects/:id/feedback/:fb/checklist` — the triage checklist as one definition gives it
 * (REQ-34 BC-3): the form a person fills, the `answers` an agent sends with a triage (the route is
 * the triage's own `route`), how the item stands against it now (what its record answers, each gap
 * in plain words), and its moves into triaged, a move recorded before the checklist reading
 * `no_checklist`.
 */
feedbackChecklistRoutes.get(
  '/:id/feedback/:fb/checklist',
  zValidator(
    'param',
    z.object({ id: z.uuid(), fb: z.string().trim().min(1).max(64) }),
    invalid('invalid path: a project uuid and a feedback uuid or key (FB-n)'),
  ),
  async (c) => {
    const { id, fb } = c.req.valid('param');
    const agency = c.get('agency');
    if (!agency)
      throw new Error('feedback checklist: a request reached its handler without an auth gate');
    // read as the viewer, so an item they may not read is refused before its record is
    const item = await detailAs({ userId: c.get('userId'), agency }, id, fb);
    const checklist = FEEDBACK_TRIAGE_CHECKLIST;
    const record = await feedbackTriageRecord(db, item.id);
    const moves = await gatedMovesOf(db, FEEDBACK_MACHINE, item.id);
    return c.json({
      feedbackId: item.id,
      key: item.key,
      checklists: [
        {
          id: checklist.id,
          version: checklist.version,
          gates: checklist.gates,
          design: checklist.design,
          form: checklistFormOf(checklist),
          input: triageAnswersInput(),
          now: evaluateChecklist(checklist, { given: {}, record }),
          moves: moves
            .filter((m) => m.to === checklist.gates.to)
            .map((m) => ({ ...m, countsAsPassed: countsAsPassed(m.standing) })),
        },
      ],
    });
  },
);
