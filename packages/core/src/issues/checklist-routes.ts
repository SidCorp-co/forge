import { checklistsOn } from '@forge/contracts/checklist-registry';
import {
  checklistFormOf,
  checklistInputOf,
  countsAsPassed,
  evaluateChecklist,
} from '@forge/contracts/checklists';
import { ISSUE_MACHINE } from '@forge/contracts/issue-machine';
import { Hono } from 'hono';
import { db } from '../db/client.js';
import { gatedMovesOf } from '../lifecycle/index.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { idParamSchema } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { issueChecklistRecord } from './checklist-record.js';
import { heldIssue } from './issue-route-ref.js';

export const issueChecklistRoutes = new Hono<{ Variables: AuthVars }>();

issueChecklistRoutes.use('*', requireAuth(), assertEmailVerified());

/**
 * `GET /api/issues/:id/checklist` — each checklist the issue machine asks, as one definition gives
 * it: the form a person fills, the input an agent sends as the move's `answers`, how the issue
 * stands against it now (what its record answers, what would be assumed, each gap in plain words),
 * and its gated moves, a move recorded before the checklist reading `no_checklist`.
 */
issueChecklistRoutes.get('/:id/checklist', zValidator('param', idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  await heldIssue(id, c.get('userId'), 'project.read');
  const moves = await gatedMovesOf(db, ISSUE_MACHINE, id);
  const checklists = await Promise.all(
    checklistsOn(ISSUE_MACHINE).map(async (checklist) => {
      const record = await issueChecklistRecord(db, checklist.id, id);
      const onEdge = moves.filter((m) => m.to === checklist.gates.to);
      return {
        id: checklist.id,
        version: checklist.version,
        gates: checklist.gates,
        design: checklist.design,
        form: checklistFormOf(checklist),
        input: checklistInputOf(checklist),
        now: evaluateChecklist(checklist, { given: {}, record }),
        moves: onEdge.map((m) => ({ ...m, countsAsPassed: countsAsPassed(m.standing) })),
      };
    }),
  );
  return c.json({ issueId: id, checklists });
});
