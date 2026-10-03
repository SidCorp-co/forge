import { pickFields } from '@forge/contracts/projection';
import {
  REQUIREMENT_HEAD_FIELDS,
  REQUIREMENT_REVISION_HEAD_FIELDS,
  type RequirementAct,
  type RequirementActAnswer,
  type RequirementRevisionWritten,
  type RequirementSummaryView,
} from '@forge/contracts/requirements';
import type { listRequirementsAs, RequirementDetail } from './read.js';

type ListedRequirement = Awaited<ReturnType<typeof listRequirementsAs>>[number];

export function requirementSummaryOf(row: ListedRequirement): RequirementSummaryView {
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    status: row.status,
    state: row.standing.state,
    currentRevision: row.currentRevision,
    latestRevision: row.latestRevision,
    counts: row.standing.facts,
    waitingOn: row.standing.waitingOn,
    updatedAt: row.updatedAt,
  };
}

const WRITES_A_REVISION: ReadonlySet<RequirementAct> = new Set(['create', 'revise', 'edit']);
const DECIDES_A_REVISION: ReadonlySet<RequirementAct> = new Set([
  'propose',
  'accept',
  'return',
  'agree',
]);
const WRITES_A_BASELINE: ReadonlySet<RequirementAct> = new Set(['agree', 'repin']);

function revisionIn(detail: RequirementDetail, act: RequirementAct, revision: number | undefined) {
  const wanted = revision ?? detail.latestRevision?.revision;
  const row = detail.revisions.find((r) => r.revision === wanted);
  if (!row) {
    throw new Error(
      `requirements: ${act} on ${detail.key} answered no revision ${wanted ?? '(none)'}; the read holds ${detail.revisions.map((r) => r.revision).join(', ') || 'none'}`,
    );
  }
  return row;
}

export function requirementActAnswerOf(
  detail: RequirementDetail,
  act: RequirementAct,
  revision?: number,
): RequirementActAnswer {
  const answer: RequirementActAnswer = {
    act,
    requirement: pickFields(detail, REQUIREMENT_HEAD_FIELDS),
  };
  if (WRITES_A_REVISION.has(act)) {
    const row = revisionIn(detail, act, revision);
    const written: RequirementRevisionWritten = {
      ...pickFields(row, REQUIREMENT_REVISION_HEAD_FIELDS),
      criteria: row.criteria.map((c) => ({ code: c.code, form: c.form, body: c.body })),
    };
    answer.revision = written;
  }
  if (DECIDES_A_REVISION.has(act)) {
    answer.revision = pickFields(
      revisionIn(detail, act, revision),
      REQUIREMENT_REVISION_HEAD_FIELDS,
    );
  }
  if (WRITES_A_BASELINE.has(act)) {
    const baseline = detail.baselines[0];
    if (baseline) {
      answer.baseline = {
        revision: baseline.revision,
        seq: baseline.seq,
        agreedAt: baseline.agreedAt,
        pins: baseline.pins.length,
      };
    }
  }
  if (act === 'link_issue' || act === 'unlink_issue') answer.issues = detail.issues;
  if (act === 'link_workflow' || act === 'unlink_workflow') answer.workflows = detail.workflows;
  return answer;
}
