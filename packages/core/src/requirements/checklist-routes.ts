import {
  REQUIREMENT_ACCEPTANCE_CHECKLIST,
  REQUIREMENT_READY_CHECKLIST,
} from '@forge/contracts/checklist-registry';
import type {
  ChecklistMove,
  ChecklistRead,
  RequirementChecklistsRead,
} from '@forge/contracts/checklist-read';
import {
  type Checklist,
  checklistFormOf,
  checklistInputOf,
  evaluateChecklist,
  type RecordAnswers,
} from '@forge/contracts/checklists';
import { countsAsPassed } from '@forge/contracts/move-gates';
import { REQUIREMENT_MACHINE } from '@forge/contracts/requirement-machine';
import { requirementKey } from '@forge/contracts/requirements';
import { Hono } from 'hono';
import { db } from '../db/client.js';
import { activeIssuePrefix } from '../issues/index.js';
import { gatedMovesOf } from '../lifecycle/index.js';
import { assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { deliveryIn, liveBuildOfRequirement } from './acceptance.js';
import {
  acceptanceAnswersOf,
  requirementReadyRecord,
  uncitedVerdictsIn,
} from './checklist-record.js';
import { type Row, rowIn } from './read.js';
import { actorOf, type RequirementEnv, reqParam } from './route-kit.js';

export const requirementChecklistRoutes = new Hono<RequirementEnv>();

requirementChecklistRoutes.use(
  '/:id/requirements/:req/checklist',
  requireAuth(),
  assertEmailVerified(),
);

/** Whether the requirement has reached a status the checklist is asked from, or moved through it. */
const reached = (checklist: Checklist, status: string, moves: readonly ChecklistMove[]) =>
  checklist.gates.from.includes(status) || moves.some((m) => m.standing !== 'refused');

/** What the requirement's record answers to the acceptance checklist now, read as the accept reads it. */
async function acceptanceRecord(projectId: string, row: Row): Promise<RecordAnswers> {
  const liveBuild = await liveBuildOfRequirement(projectId, row.id);
  const { proof } = await deliveryIn(db, projectId, row, liveBuild);
  const uncited = await uncitedVerdictsIn(db, row.id, await activeIssuePrefix(projectId));
  return acceptanceAnswersOf(proof, uncited);
}

/**
 * `GET /api/projects/:id/requirements/:req/checklist` — the ready and the acceptance checklists, as
 * one definition gives each (REQ-34 BC-3, BC-5): the form, the input a mover sends, how the head
 * revision stands against it now (each answer given or assumed with its source, each gap in plain
 * words), and its moves, a move recorded before the checklist reading `no_checklist` (BC-9). `now`
 * is null for a checklist the requirement has not reached: acceptance on a draft.
 */
requirementChecklistRoutes.get('/:id/requirements/:req/checklist', reqParam, async (c) => {
  const { id, req } = c.req.valid('param');
  await requireCan(actorFor(actorOf(c).userId), 'project.read', projectResource(id));
  const row = await rowIn(db, id, req);
  const moves = await gatedMovesOf(db, REQUIREMENT_MACHINE, row.id);
  const asked: [Checklist, () => Promise<RecordAnswers>][] = [
    [REQUIREMENT_READY_CHECKLIST, () => requirementReadyRecord(db, row.id)],
    [REQUIREMENT_ACCEPTANCE_CHECKLIST, () => acceptanceRecord(id, row)],
  ];
  const checklists: ChecklistRead[] = [];
  for (const [checklist, record] of asked) {
    const onEdge = moves
      .filter((m) => m.gate === checklist.id)
      .map((m) => ({ ...m, countsAsPassed: countsAsPassed(m.standing) }));
    checklists.push({
      id: checklist.id,
      version: checklist.version,
      gates: checklist.gates,
      design: checklist.design,
      form: checklistFormOf(checklist),
      input: checklistInputOf(checklist),
      now: reached(checklist, row.status, onEdge)
        ? evaluateChecklist(checklist, { given: {}, record: await record() })
        : null,
      moves: onEdge,
    });
  }
  const read: RequirementChecklistsRead = {
    requirementId: row.id,
    key: requirementKey(row.reqSeq),
    revision: row.currentRevision,
    checklists,
  };
  return c.json(read);
});
