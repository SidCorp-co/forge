/**
 * What accepting a suggestion writes, kind by kind, inside the accept's transaction (workflow
 * `suggestion-lifecycle` rev 2: "its effect — a revision, issues, a triage — was written in the same
 * transaction and points back at it"). Each writer returns refusals that roll the accept back, or
 * the effect the caller reads back.
 */

import type { FeedbackTriageEffect } from '@forge/contracts/feedback';
import { requirementKey } from '@forge/contracts/requirements';
import { SUGGESTION_MACHINE } from '@forge/contracts/suggestion-machine';
import { SUGGESTION_PAYLOADS, type SuggestionEffect } from '@forge/contracts/suggestions';
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { requirementRevisions } from '../db/schema-requirements.js';
import { suggestions } from '../db/schema-suggestions.js';
import { rowIn as feedbackRowIn, triageIn } from '../feedback/index.js';
import type { Refusal } from '../lib/refusal.js';
import { transition } from '../lifecycle/index.js';
import {
  createRequirementIn,
  dropAsDuplicateIn,
  newDraftRevisionIn,
  type RevisionWrite,
  rowIn,
} from '../requirements/index.js';
import { breakdownEffect } from './breakdown.js';
import { firstRequirementRefusalsIn } from './first-requirement.js';
import { linkedDesignIds } from './first-requirement-rules.js';
import { authorOf, issueTriageEffect } from './issue-triage-effect.js';
import { type Row, type SuggestionActor, suggestionKernelActor, targetOfRow } from './read.js';

export type Effect = SuggestionEffect | FeedbackTriageEffect;
export type AcceptChannel = 'web' | 'mcp';

export interface EffectWritten {
  refusals: Refusal[] | null;
  effect?: Effect;
}

// Workflow requirement-to-delivery step `ready`: readiness is a suggestion kind with no table
// of its own, so the accepted row at its base revision IS the readiness result an agree reads
async function readinessEffect(tx: Tx, projectId: string, row: Row): Promise<EffectWritten> {
  const req = await rowIn(tx, projectId, targetOfRow(row).id);
  const { checks } = SUGGESTION_PAYLOADS.readiness.schema.parse(row.payload);
  const failed = checks.filter((c) => !c.passed).map((c) => c.check);
  return {
    refusals: null,
    effect: {
      requirementId: req.id,
      requirement: requirementKey(req.reqSeq),
      revision: row.baseRevision,
      ready: failed.length === 0,
      failed,
    },
  };
}

export async function writeEffect(
  tx: Tx,
  projectId: string,
  row: Row,
  head: number | null,
  actor: SuggestionActor,
  channel: AcceptChannel,
): Promise<EffectWritten> {
  const target = targetOfRow(row);
  if (row.kind === 'feedback_triage' && target.type === 'feedback') {
    const { dedup: _dedup, ...triage } = SUGGESTION_PAYLOADS.feedback_triage.schema.parse(
      row.payload,
    );
    const written = await triageIn(tx, {
      projectId,
      row: await feedbackRowIn(tx, projectId, target.id, true),
      triage,
      actor,
      channel,
      fromSuggestionId: row.id,
    });
    if (written.refusals?.length) return { refusals: written.refusals };
    return { refusals: null, ...(written.effect ? { effect: written.effect } : {}) };
  }
  if (row.kind === 'revision_diff' && target.type === 'requirement') {
    const write = SUGGESTION_PAYLOADS.revision_diff.schema.parse(row.payload) as RevisionWrite;
    const refusals = await newDraftRevisionIn(tx, {
      requirementId: target.id,
      head,
      baseRevision: row.baseRevision,
      actor: authorOf(row, actor),
      write: { ...write, fromSuggestionId: row.id },
    });
    if (refusals?.length) return { refusals };
    const [written] = await tx
      .select({ revision: requirementRevisions.revision })
      .from(requirementRevisions)
      .where(eq(requirementRevisions.fromSuggestionId, row.id));
    const req = await rowIn(tx, projectId, target.id);
    const supersededBy = `suggestion ${row.id} was accepted as a new draft revision of this requirement`;
    await transition(tx, SUGGESTION_MACHINE, {
      to: 'stale',
      from: 'proposed',
      set: { decidedAt: new Date(), reason: supersededBy },
      where: and(eq(suggestions.requirementId, target.id), sql`${suggestions.id} <> ${row.id}`),
      reason: supersededBy,
      actor: suggestionKernelActor(actor),
      source: 'suggestions-effect',
      returning: ['id'],
    });
    return {
      refusals: null,
      effect: {
        requirementId: target.id,
        requirement: requirementKey(req.reqSeq),
        revision: written?.revision ?? 0,
      },
    };
  }
  if (row.kind === 'requirement_draft') {
    const {
      title,
      designs: named,
      ...write
    } = SUGGESTION_PAYLOADS.requirement_draft.schema.parse(row.payload);
    // a design returned or replaced since the proposal no longer roots a first requirement
    const wrong = await firstRequirementRefusalsIn(tx, projectId, target, row.payload, row.id);
    if (wrong.length) return { refusals: wrong };
    const designs = target.type === 'workflow' ? linkedDesignIds(target.id, named) : [];
    const created = await createRequirementIn(tx, {
      projectId,
      actor,
      authorId: authorOf(row, actor).userId,
      title,
      write: { ...(write as RevisionWrite), fromSuggestionId: row.id },
      designs,
    });
    if (created.refusals?.length) return { refusals: created.refusals };
    const req = await rowIn(tx, projectId, created.id);
    return {
      refusals: null,
      effect: {
        requirementId: created.id,
        requirement: requirementKey(req.reqSeq),
        revision: 1,
        ...(designs.length ? { designs } : {}),
      },
    };
  }
  if (row.kind === 'breakdown' && target.type === 'requirement') {
    return breakdownEffect(tx, projectId, row, head, actor, channel);
  }
  if (row.kind === 'readiness' && target.type === 'requirement') {
    return readinessEffect(tx, projectId, row);
  }
  if (row.kind === 'triage' && target.type === 'issue') {
    return issueTriageEffect(tx, projectId, row, actor);
  }
  // an accepted design_change writes nothing into the design: the acceptance is the record that the
  // design owes a revision touching those nodes (REQ-17 BC-12)
  if (row.kind === 'design_change' && target.type === 'workflow') return { refusals: null };
  // requirement-to-delivery `ready`: a near-duplicate is merged before agreeing, so accepting the
  // duplicate drops this requirement naming the one it repeats, through the requirements kernel
  if (row.kind === 'duplicate' && target.type === 'requirement') {
    const p = SUGGESTION_PAYLOADS.duplicate.schema.parse(row.payload);
    const dropped = await dropAsDuplicateIn(tx, {
      projectId,
      requirementId: target.id,
      duplicateOf: p.duplicateOf,
      note: p.note,
      suggestionId: row.id,
      actor,
    });
    if (dropped.refusals) return { refusals: dropped.refusals };
    return {
      refusals: null,
      effect: {
        requirementId: target.id,
        requirement: dropped.requirement,
        duplicateOf: dropped.duplicateOf,
        status: 'dropped',
      },
    };
  }
  throw new Error(`suggestions: no effect writer for a ${row.kind} suggestion on ${target.type}`);
}
