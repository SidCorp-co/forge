// A park re-pointed at what it waits on now (FB-141), or re-kinded to the kind of wait it is now
// (ISS-631, FB-264): a call at `needs_info` that names the design revisions or the merge mark its
// park waits on replaces what the park waited on, and one naming a `waitingKind` other than the
// park's own changes what kind of wait it is — a decision settled that now waits on a resource. No
// status moves, so no kernel transition is written: the park keeps the status it left and its step,
// the questions it asked are withdrawn naming the new wait, the park record says what it waits on now
// (`park-since.ts` reads its moment), and the new wait's questions are asked in the same
// transaction. Naming exactly the kind and the wait the park already holds changes nothing: `NO_OP`.

import {
  AUTONOMOUS_QUESTION_STATUS,
  type IssueTransitionRefusalCode,
} from '@forge/contracts/issue-machine';
import type { QuestionAboutRequest } from '@forge/contracts/questions';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { IssueStatus, WaitingKind } from '../db/schema.js';
import type { WorkStep } from '../db/schema-issue-work-state.js';
import { lockXact } from '../lib/advisory-lock.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { RefusalError } from '../lib/refusal.js';
import { actorAgency, kernelActorFor, type TransitionActor } from './actor-agency.js';
import type { DrizzleTx } from './dependency-executor.js';
import { activeIssuePrefix } from './issue-prefix-read.js';
import { type AwaitedDesignRef, mintParkQuestion, needsNotApplicable } from './park-question.js';
import { openParkWaitsOn, postIssueNotice, withdrawParkQuestions } from './ports.js';
import { recordRepoint } from './record-events/kernel-records.js';
import { emitIssueFieldUpdate } from './update-hook.js';

interface RepointOptions {
  transitionReason?: string | undefined;
  reason?: string | undefined;
  waitingKind?: WaitingKind | undefined;
  needs?: string | undefined;
  awaitsDesign?: readonly AwaitedDesignRef[] | undefined;
  awaitsMerge?: { issueId: string } | undefined;
  about?: QuestionAboutRequest | undefined;
}

/** The first line of a re-point's notice, which `transition-reason.ts:announcesAMove` reads as no reply. */
export const REPOINT_HEADING = `↪ **Re-pointed \`${AUTONOMOUS_QUESTION_STATUS}\`**`;

/** Whether this call at `status` re-points or re-kinds the park rather than moving the issue: it
 *  names a wait, or the kind of wait the park is. */
export function repointsPark(status: IssueStatus, options: RepointOptions): boolean {
  return (
    status === AUTONOMOUS_QUESTION_STATUS &&
    (Boolean(options.awaitsDesign?.length) ||
      options.awaitsMerge !== undefined ||
      options.waitingKind !== undefined)
  );
}

/** What a park of each kind waits on, as a re-kind's notice and its withdrawn questions say it. */
const KIND_WAITS_ON: Record<WaitingKind, string> = {
  needs_answer: 'an answer from a person',
  needs_decision: 'a decision from a person',
  needs_resource: 'something a person supplies',
};

function refused(
  code: IssueTransitionRefusalCode,
  detail: string,
  details: Record<string, unknown> = {},
): RefusalError {
  return new RefusalError([{ ...details, code, path: '', detail }], code);
}

type Wait = { design: AwaitedDesignRef } | { merge: { issueId: string } } | { other: string };

const keyOf = (w: Wait) =>
  'design' in w
    ? `design:${w.design.workflowId}:${w.design.revision}`
    : 'merge' in w
      ? `merge:${w.merge.issueId}`
      : `other:${w.other}`;

/** Each wait said by name: a design by its flow and revision, a mark by its issue's key. */
async function describe(tx: DrizzleTx, projectId: string, waits: readonly Wait[]): Promise<string> {
  const flows = new Map<string, string>();
  const designIds = waits.flatMap((w) => ('design' in w ? [w.design.workflowId] : []));
  if (designIds.length > 0) {
    const rows = (await tx.execute(sql`
      SELECT id, flow FROM project_workflows
       WHERE id IN (${sql.join(
         designIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})`)) as unknown as Array<{ id: string; flow: string }>;
    for (const r of rows) flows.set(String(r.id), String(r.flow));
  }
  const keys = new Map<string, string>();
  const mergeIds = waits.flatMap((w) => ('merge' in w ? [w.merge.issueId] : []));
  if (mergeIds.length > 0) {
    const prefix = await activeIssuePrefix(projectId);
    const rows = (await tx.execute(sql`
      SELECT id, iss_seq FROM issues
       WHERE id IN (${sql.join(
         mergeIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})`)) as unknown as Array<{ id: string; iss_seq: number }>;
    for (const r of rows) keys.set(String(r.id), formatIssueRef(prefix, Number(r.iss_seq)));
  }
  const said = waits.map((w) => {
    if ('design' in w) {
      const flow = flows.get(w.design.workflowId) ?? w.design.workflowId;
      return `a decision on design \`${flow}\` revision ${w.design.revision}`;
    }
    if ('merge' in w) return `the merge mark of ${keys.get(w.merge.issueId) ?? w.merge.issueId}`;
    return 'an answer from a person';
  });
  return said.length === 0 ? 'nothing' : said.join(', ');
}

/**
 * Replace what the park waits on, and what kind of wait it is, with what this call names. Refused by
 * name: a wait no question can carry or one a person's credential cannot name
 * (`park-question.ts:needsNotApplicable`), an issue no longer at the park, the kind and wait it
 * already holds (`NO_OP`), and no reason. A question the park asked that nobody answered yet is
 * withdrawn naming the new wait, never left saying a person owes it.
 */
export async function repointPark(input: {
  issue: { id: string; projectId: string; reopenCount: number };
  actor: TransitionActor;
  options: RepointOptions;
  step: WorkStep | null;
  /** The status the park left (`issue_work_state.left_status`), which its record restates. */
  leftStatus: IssueStatus | null;
}): Promise<{
  id: string;
  status: IssueStatus;
  reopenCount: number;
  updatedAt: Date;
  terminal: boolean;
  unblockedDependents: [];
  step: WorkStep | null;
  repointed: { withdrawn: string[]; asked: string[] };
}> {
  const { issue, actor, options } = input;
  const status = AUTONOMOUS_QUESTION_STATUS;
  const base = { from: status, to: status };
  const notApplicable = needsNotApplicable({ issue, toStatus: status, actor, options });
  if (notApplicable) throw refused('NEEDS_NOT_APPLICABLE', notApplicable, base);
  const reason = options.transitionReason?.trim() ?? '';
  const wanted: Wait[] = options.awaitsDesign?.length
    ? options.awaitsDesign.map((d) => ({ design: d }))
    : options.awaitsMerge
      ? [{ merge: options.awaitsMerge }]
      : [];
  const by = actor.type === 'user' ? actor.id : actor.ownerId;

  return db.transaction(async (tx) => {
    // the workflow lock before the issue row, the order a decision or a superseding write takes them in
    if (options.awaitsDesign?.length) await lockXact(tx, 'workflows', issue.projectId);
    const rows = (await tx.execute(
      sql`SELECT status, waiting_kind FROM issues WHERE id = ${issue.id} FOR UPDATE`,
    )) as unknown as Array<{ status: IssueStatus; waiting_kind: WaitingKind | null }>;
    const row = rows[0];
    if (row?.status !== status) {
      throw refused(
        'STALE_TRANSITION',
        `the issue was expected at \`${status}\` for its park to be re-pointed, and it is at \`${row?.status ?? 'nothing: it was deleted'}\` — read it again and park it from there`,
        { ...base, expected: status, actual: row?.status ?? null },
      );
    }
    const heldKind = row.waiting_kind;
    const kind = options.waitingKind ?? heldKind;
    const rekinded = kind !== heldKind;
    const held: Wait[] = (await openParkWaitsOn(tx, issue.id)).map((w) =>
      w.awaitsDesign
        ? { design: w.awaitsDesign }
        : w.awaitsMerge
          ? { merge: w.awaitsMerge }
          : { other: w.questionId },
    );
    const heldKeys = new Set(held.map(keyOf));
    const wantedKeys = new Set(wanted.map(keyOf));
    const now = await describe(tx, issue.projectId, wanted);
    if (!rekinded && wanted.length === 0) {
      throw refused(
        'NO_OP',
        `the park is already a \`${heldKind ?? 'none'}\` park and this call names no other wait, so it changes nothing — send another \`waitingKind\` to change what kind of wait it is, or \`awaitsDesign\` or \`awaitsMerge\` to change what it waits on`,
        { ...base, status, waitingKind: heldKind },
      );
    }
    if (
      !rekinded &&
      heldKeys.size === wantedKeys.size &&
      [...wantedKeys].every((k) => heldKeys.has(k))
    ) {
      throw refused(
        'NO_OP',
        `the park already waits on exactly ${now}, so re-pointing it there changes nothing — name the wait it should hold instead`,
        { ...base, status },
      );
    }
    if (!reason) {
      throw refused(
        'TRANSITION_REASON_REQUIRED',
        'a re-point or re-kind of a park carries why it now waits on this, as `reason`: it is the question the new wait asks, and the thread reads it',
        base,
      );
    }
    const before = await describe(tx, issue.projectId, held);
    const waitsOn =
      rekinded && kind ? `${KIND_WAITS_ON[kind]}${wanted.length > 0 ? `, ${now}` : ''}` : now;
    const said = rekinded
      ? `This park is now a \`${kind}\` park, waiting on ${waitsOn}, in place of \`${heldKind ?? 'none'}\`${held.length > 0 ? ` and ${before}` : ''}. It still returns to the status it left once every one is settled.`
      : `This park now waits on ${now}, in place of ${before}. It still returns to the status it left once every one is settled.`;
    await postIssueNotice(
      { issueId: issue.id, authorId: by, body: [REPOINT_HEADING, '', said, '', reason].join('\n') },
      tx,
    );
    // withdrawn before the record below moves the park's moment, which is what marks them its own
    const withdrawn = await withdrawParkQuestions(tx, {
      issueId: issue.id,
      toStatus: status,
      reason,
      by,
      actor: kernelActorFor(actor),
      repointedTo: waitsOn,
    });
    const recorder = { type: actor.type, id: actor.id, agency: actorAgency(actor) };
    if (rekinded) {
      await tx.execute(
        sql`UPDATE issues SET waiting_kind = ${kind}, updated_at = now() WHERE id = ${issue.id}`,
      );
      await emitIssueFieldUpdate(tx, {
        before: { id: issue.id, projectId: issue.projectId, waitingKind: heldKind },
        after: { id: issue.id, projectId: issue.projectId, waitingKind: kind },
        written: ['waitingKind'],
        actor: recorder,
      });
    }
    await recordRepoint(tx, {
      issueId: issue.id,
      actor: recorder,
      waitingKind: kind,
      rekindFrom: rekinded ? heldKind : null,
      reason,
      leftStatus: input.leftStatus,
      needs: options.needs?.trim() || null,
    });
    await mintParkQuestion(
      { issue, toStatus: status, actor, options: { ...options, waitingKind: kind ?? undefined } },
      tx,
    );
    const asked = (await openParkWaitsOn(tx, issue.id)).map((w) => w.questionId);
    return {
      id: issue.id,
      status,
      reopenCount: issue.reopenCount,
      updatedAt: new Date(),
      terminal: false,
      unblockedDependents: [],
      step: input.step,
      repointed: { withdrawn, asked },
    };
  });
}
