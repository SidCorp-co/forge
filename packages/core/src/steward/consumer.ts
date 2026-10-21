// The outbox consumer `steward` (REQ-48 BC-1): each handoff event becomes a run on the item it is
// about, inserted or folded inside the delivery's own transaction (`delivery.inbox`), so a redelivery
// after the commit finds the trigger already folded. A steward job's end settles its run.

import type { StandingSubjectKind, StewardTrigger } from '@forge/contracts/steward';
import { consume, type Delivery } from '../outbox/index.js';
import { isUndoOverride } from './acts-store.js';
import { settleJobRun } from './dispatch.js';
import { foldTrigger, runOfJob } from './runs-store.js';
import { issueSubjects, type SubjectRow, subjectOf } from './subjects.js';

/** Fold `trigger` into a run on each subject that exists; one that does not is not the steward's. */
async function fold(
  delivery: Delivery,
  projectId: string,
  subjects: readonly SubjectRow[],
  trigger: StewardTrigger,
  basis: string | null = null,
): Promise<void> {
  if (subjects.length === 0) return;
  await delivery.inbox(async (tx) => {
    for (const subject of subjects) {
      await foldTrigger(tx, {
        projectId,
        subject: { kind: subject.kind, id: subject.id, key: subject.key },
        trigger,
        outboxId: delivery.eventId,
        at: delivery.createdAt,
        basis,
      });
    }
  });
}

async function one(
  projectId: string,
  kind: StandingSubjectKind,
  id: string,
): Promise<SubjectRow[]> {
  const row = await subjectOf(projectId, kind, id);
  return row ? [row] : [];
}

export function registerSteward(): void {
  consume('requirement.agreed', {
    name: 'steward',
    handle: async (p, d) =>
      fold(
        d,
        p.projectId,
        await one(p.projectId, 'requirement', p.requirementId),
        'requirement.agreed',
      ),
  });

  // a breakdown a person re-proposed by undoing the steward's rejection is their override (BC-12)
  consume('suggestion.proposed', {
    name: 'steward',
    handle: async (p, d) => {
      if (p.kind !== 'breakdown' || p.targetKind !== 'requirement') return;
      if (await isUndoOverride(p.projectId, p.suggestionId)) return;
      await fold(
        d,
        p.projectId,
        await one(p.projectId, 'requirement', p.targetId),
        'breakdown.proposed',
      );
    },
  });

  consume('feedback.filed', {
    name: 'steward',
    handle: async (p, d) =>
      fold(d, p.projectId, await one(p.projectId, 'feedback', p.feedbackId), 'feedback.filed'),
  });

  consume('standing.stuck', {
    name: 'steward',
    handle: async (p, d) =>
      fold(
        d,
        p.projectId,
        await one(p.projectId, p.subject.kind, p.subject.id),
        'standing.stuck',
        p.basis,
      ),
  });

  consume('standing.changed', {
    name: 'steward',
    handle: async (p, d) =>
      fold(
        d,
        p.projectId,
        await one(p.projectId, p.subject.kind, p.subject.id),
        'standing.changed',
        p.basis,
      ),
  });

  // BC-6, decision 1: entering awaiting_release is answered by the output check, never gated by it
  consume('issue.transitioned', {
    name: 'steward',
    handle: async (p, d) => {
      if (p.to !== 'awaiting_release') return;
      await fold(d, p.projectId, await one(p.projectId, 'issue', p.id), 'release.asked');
    },
  });

  consume('release.held', {
    name: 'steward',
    handle: async (p, d) =>
      fold(
        d,
        p.projectId,
        await issueSubjects(
          p.projectId,
          p.held.map((h) => h.issueId),
        ),
        'release.held',
      ),
  });

  consume('release.shipped', {
    name: 'steward',
    handle: async (p, d) =>
      fold(d, p.projectId, await issueSubjects(p.projectId, p.issueIds), 'release.shipped'),
  });

  consume('job.transitioned', {
    name: 'steward',
    handle: async (p) => {
      const run = await runOfJob(p.id);
      if (run) await settleJobRun(run, p.to);
    },
  });
}
