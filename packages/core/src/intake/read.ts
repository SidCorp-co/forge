/**
 * An item's intake draft as its page reads it (`GET /api/projects/:id/intake-drafts/:ref`): REQ-n or
 * FB-n, the draft that stands for it, or null while none was made. An agent reads it through the
 * project's data policy like the item itself.
 */

import { feedbackKey } from '@forge/contracts/feedback';
import {
  type IntakeDraftApplied,
  type IntakeDraftAssumption,
  type IntakeDraftLink,
  type IntakeDraftUnaffected,
  type IntakeDraftView,
  type IntakeItemKind,
  type IntakeQuestion,
  type IntakeRead,
  intakeItemOfRef,
} from '@forge/contracts/intake-drafts';
import type { ActorAgency } from '@forge/contracts/permissions';
import { requirementKey } from '@forge/contracts/requirements';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { feedback } from '../db/schema-feedback.js';
import { type IntakeDraftRow, intakeDrafts } from '../db/schema-intake.js';
import { requirements } from '../db/schema-requirements.js';
import { egressForRequest } from '../lib/data-egress.js';
import type { Refusal } from '../lib/refusal.js';
import { notFound } from '../middleware/route-errors.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';

export type IntakeReadOutcome =
  | { ok: true; draft: IntakeDraftView | null }
  | { ok: false; refusals: Refusal[] };

interface Body {
  links: IntakeDraftLink[];
  /** Absent on a draft kept before core offered the workflows an item touches. */
  notAffected?: IntakeDraftUnaffected[];
  assumptions: IntakeDraftAssumption[];
  questions: IntakeQuestion[];
  nothingToAsk: string | null;
}

export function viewOf(
  row: IntakeDraftRow,
  item: { kind: IntakeItemKind; key: string },
): IntakeDraftView {
  const body = (row.body ?? null) as Body | null;
  return {
    item,
    outcome: row.outcome,
    code: row.code ?? null,
    detail: row.detail ?? null,
    at: row.draftedAt.toISOString(),
    model: row.model,
    attempts: row.attempts,
    retrying: row.retryOwed,
    read: row.read as Record<IntakeRead, number>,
    links: body?.links ?? [],
    notAffected: body?.notAffected ?? [],
    assumptions: body?.assumptions ?? [],
    questions: body?.questions ?? [],
    nothingToAsk: body?.nothingToAsk ?? null,
    applied: (row.applied ?? null) as IntakeDraftApplied | null,
  };
}

async function itemIdOf(
  projectId: string,
  kind: IntakeItemKind,
  seq: number,
): Promise<string | null> {
  if (kind === 'requirement') {
    const [r] = await db
      .select({ id: requirements.id })
      .from(requirements)
      .where(and(eq(requirements.projectId, projectId), eq(requirements.reqSeq, seq)))
      .limit(1);
    return r?.id ?? null;
  }
  const [f] = await db
    .select({ id: feedback.id })
    .from(feedback)
    .where(and(eq(feedback.projectId, projectId), eq(feedback.fbSeq, seq)))
    .limit(1);
  return f?.id ?? null;
}

export async function readIntakeDraft(input: {
  projectId: string;
  ref: string;
  viewer: { userId: string; agency: ActorAgency };
}): Promise<IntakeReadOutcome> {
  const { projectId, ref, viewer } = input;
  await requireCan(actorFor(viewer.userId), 'project.read', projectResource(projectId));
  const named = intakeItemOfRef(ref);
  if (!named) {
    return {
      ok: false,
      refusals: [
        {
          code: 'INTAKE_REF_INVALID',
          path: '/ref',
          detail: `"${ref.slice(0, 64)}" names no requirement or feedback item: send REQ-n or FB-n`,
        },
      ],
    };
  }
  const key = named.kind === 'requirement' ? requirementKey(named.seq) : feedbackKey(named.seq);
  const id = await itemIdOf(projectId, named.kind, named.seq);
  if (!id) throw notFound(`project ${projectId} holds no ${key}`);
  const [row] = await db
    .select()
    .from(intakeDrafts)
    .where(
      named.kind === 'requirement'
        ? eq(intakeDrafts.requirementId, id)
        : eq(intakeDrafts.feedbackId, id),
    )
    .limit(1);
  if (!row) return { ok: true, draft: null };
  const view = viewOf(row, { kind: named.kind, key });
  const surface = named.kind === 'feedback' ? 'feedback' : 'requirement';
  return {
    ok: true,
    draft: await egressForRequest(viewer.agency, projectId, surface, view, `the draft of ${key}`),
  };
}
