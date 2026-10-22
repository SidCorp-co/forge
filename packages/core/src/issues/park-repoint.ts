// A park re-pointed at what it waits on now (FB-141): an agent at `needs_info` that names the design
// revisions, or the merge mark, its park waits on replaces what the park waited on. No status moves,
// so no kernel transition is written: the park keeps the status it left and its step, the questions
// it asked are withdrawn naming the new wait, and the new wait's questions are asked in the same
// transaction. Naming exactly what the park already waits on changes nothing, and is `NO_OP`.

import {
  AUTONOMOUS_QUESTION_STATUS,
  type IssueTransitionRefusalCode,
} from '@forge/contracts/issue-machine';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { IssueStatus, WaitingKind } from '../db/schema.js';
import type { WorkStep } from '../db/schema-issue-work-state.js';
import { lockXact } from '../lib/advisory-lock.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { RefusalError } from '../lib/refusal.js';
import { kernelActorFor, type TransitionActor } from './actor-agency.js';
import type { DrizzleTx } from './dependency-executor.js';
import { activeIssuePrefix } from './issue-prefix-read.js';
import { type AwaitedDesignRef, mintParkQuestion, needsNotApplicable } from './park-question.js';
import { openParkWaitsOn, postIssueNotice, withdrawParkQuestions } from './ports.js';

interface RepointOptions {
  transitionReason?: string | undefined;
  reason?: string | undefined;
  waitingKind?: WaitingKind | undefined;
  needs?: string | undefined;
  awaitsDesign?: readonly AwaitedDesignRef[] | undefined;
  awaitsMerge?: { issueId: string } | undefined;
}

/** The first line of a re-point's notice, which `transition-reason.ts:announcesAMove` reads as no reply. */
export const REPOINT_HEADING = `↪ **Re-pointed \`${AUTONOMOUS_QUESTION_STATUS}\`**`;

/** Whether this call at `status` re-points the park rather than moving the issue: it names a wait. */
export function repointsPark(status: IssueStatus, options: RepointOptions): boolean {
  return (
    status === AUTONOMOUS_QUESTION_STATUS &&
    (Boolean(options.awaitsDesign?.length) || options.awaitsMerge !== undefined)
  );
}

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
 * Replace what the park waits on with the wait this call names. Refused by name: a person's
 * credential or a wait no question can carry (`park-question.ts:needsNotApplicable`), no reason, a
 * `waitingKind` other than the park's own, an issue no longer at the park, and a wait it already holds.
 */
export async function repointPark(input: {
  issue: { id: string; projectId: string; reopenCount: number };
  actor: TransitionActor;
  options: RepointOptions;
  step: WorkStep | null;
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
  if (!reason) {
    throw refused(
      'TRANSITION_REASON_REQUIRED',
      'a re-point of a park carries why it now waits on this, as `reason`: it is the question the new wait asks, and the thread reads it',
      base,
    );
  }
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
    if (options.waitingKind && options.waitingKind !== row.waiting_kind) {
      throw refused(
        'WAITING_KIND_NOT_APPLICABLE',
        `a re-point replaces what the park waits on and keeps what kind of park it is, which is \`${row.waiting_kind ?? 'none'}\`; \`waitingKind: ${options.waitingKind}\` would change it. Send the re-point without \`waitingKind\`, or leave the park and park again with the kind it should be`,
        { ...base, waitingKind: options.waitingKind, held: row.waiting_kind },
      );
    }
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
    if (heldKeys.size === wantedKeys.size && [...wantedKeys].every((k) => heldKeys.has(k))) {
      throw refused(
        'NO_OP',
        `the park already waits on exactly ${now}, so re-pointing it there changes nothing — name the wait it should hold instead`,
        { ...base, status },
      );
    }
    const before = await describe(tx, issue.projectId, held);
    await postIssueNotice(
      {
        issueId: issue.id,
        authorId: by,
        body: [
          REPOINT_HEADING,
          '',
          `This park now waits on ${now}, in place of ${before}. It still returns to the status it left once every one is settled.`,
          '',
          reason,
        ].join('\n'),
      },
      tx,
    );
    const withdrawn = await withdrawParkQuestions(tx, {
      issueId: issue.id,
      toStatus: status,
      reason,
      by,
      actor: kernelActorFor(actor),
      repointedTo: now,
    });
    await mintParkQuestion(
      {
        issue,
        toStatus: status,
        actor,
        options: { ...options, waitingKind: row.waiting_kind ?? undefined },
      },
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
