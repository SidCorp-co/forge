/**
 * What a workflow design's own record answers to the workflow approval checklist
 * (`@forge/contracts/checklist-registry:WORKFLOW_APPROVAL_CHECKLIST`, Requirement lifecycle r15
 * design_check): the newest revision, read against the last approved one. The kernel calls it under
 * the workflow lock, through the move's transaction, on every approve; a pin-only one carries its
 * step answers from the revision it re-pins.
 *
 * Every sentence here is read by a person: the kernel refuses to judge with one that shows a record
 * field's key (`@forge/contracts/checklists:fieldKeyShownIn`).
 */

import type { RecordAnswer, RecordAnswers } from '@forge/contracts/checklists';
import { requirementKey } from '@forge/contracts/requirements';
import { criterionStepsCall } from '@forge/contracts/workflow-health';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { revisionChangesOf } from './design-changes.js';
import { pinOnlyChange } from './design-repin.js';
import { readStoredWorkflow, type WorkflowWrite } from './schema.js';
import { designsOf, readWorkflow } from './store.js';

/** Templates that draw parts and how they connect, where no step is passed through and so none can fail. */
const STRUCTURE_TEMPLATES: ReadonlySet<string> = new Set(['system-context', 'data-flow']);

const NODE_TYPES_OF_FAILURE: ReadonlySet<string> = new Set(['FAIL_POINT']);

export interface DesignFacts {
  flow: string;
  /** The newest revision, as written; null where its document cannot be read. */
  proposed: { revision: number; document: WorkflowWrite | null; raw: unknown } | null;
  /** The last approved revision's document, raw; null where none was approved. */
  approved: { revision: number; raw: unknown } | null;
  /** The live requirements that link the design, by key. */
  linkedBy: string[];
  /** Live business criteria traced to its steps or edges, as `REQ-n BC-m`. */
  traced: string[];
  /**
   * Linking requirements with no accepted revision, and how many of their criteria are traced to
   * its steps: none of those counts until a revision is current, which the gap names rather than
   * calling them untraced.
   */
  awaitingAccept: Array<{ requirement: string; traced: number }>;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function rolesOf(doc: WorkflowWrite): RecordAnswer {
  const named = doc.steps.filter((s) => s.node?.owner || s.node?.band || s.node?.persona).length;
  const lanes = (doc.lanes?.length ?? 0) + (doc.personas?.length ?? 0);
  if (named === 0 && lanes === 0) {
    return {
      gap: 'No step names who owns it, and it draws no lanes.',
      fix: 'Name an owner, lane or persona on its steps.',
    };
  }
  return {
    value: [
      named > 0 ? `${count(named, 'step names', 'steps name')} its owner or lane` : null,
      lanes > 0 ? `${count(lanes, 'lane or persona', 'lanes and personas')} drawn` : null,
    ]
      .filter(Boolean)
      .join('; '),
  };
}

function exceptionsOf(doc: WorkflowWrite): RecordAnswer {
  const conditions = doc.steps.reduce((n, s) => n + (s.node?.conditions?.length ?? 0), 0);
  const tests = doc.steps.reduce((n, s) => n + (s.node?.tests?.length ?? 0), 0);
  const failSteps = doc.steps.filter((s) => NODE_TYPES_OF_FAILURE.has(s.node?.type ?? '')).length;
  const failEdges = (doc.edges ?? []).filter((e) => e.onFailure).length;
  if (conditions + tests + failSteps + failEdges === 0) {
    return {
      gap: 'It draws no condition, test, failure point or failure edge.',
      fix: 'Draw refusals, returns and failures as conditions, tests or failure edges.',
    };
  }
  return {
    value: [
      conditions ? count(conditions, 'condition', 'conditions') : null,
      tests ? count(tests, 'test', 'tests') : null,
      failSteps ? count(failSteps, 'failure point', 'failure points') : null,
      failEdges ? count(failEdges, 'failure edge', 'failure edges') : null,
    ]
      .filter(Boolean)
      .join(', '),
  };
}

function changesOf(f: DesignFacts): RecordAnswer {
  if (!f.proposed)
    return { gap: 'It has no revision yet.', fix: 'Write and propose its first revision.' };
  if (!f.approved) return { value: 'Its first revision: nothing was approved before.' };
  const changes = revisionChangesOf(f.approved.raw, f.proposed.raw);
  if (!changes) {
    return {
      gap: `Its change from revision ${f.approved.revision} cannot be computed: one of the two is not a design this build reads.`,
      fix: 'Write the design again in a shape the schema reads, and propose it.',
    };
  }
  const names = (list: string[]) => (list.length ? list.join(', ') : 'none');
  const { steps, edges } = changes;
  return {
    value:
      `Against revision ${f.approved.revision}: steps added ${names(steps.added)}; changed ${names(steps.changed)}; removed ${names(steps.removed)}. Edges: ${edges.added} added, ${edges.changed} changed, ${edges.removed} removed.`.slice(
        0,
        2000,
      ),
  };
}

/**
 * No live criterion is traced. Where a linking requirement has traces but no accepted revision,
 * that is the gap: tracing again changes nothing, accepting a revision does.
 */
function untracedGap(f: DesignFacts): RecordAnswer {
  const waiting = f.awaitingAccept.filter((w) => w.traced > 0);
  if (waiting.length > 0) {
    const keys = waiting.map((w) => w.requirement);
    const traced = waiting.reduce((n, w) => n + w.traced, 0);
    return {
      gap: `${keys.join(', ')} ${keys.length === 1 ? 'has' : 'have'} ${count(traced, 'business criterion', 'business criteria')} traced to its steps, but no accepted revision, so none counts yet.`,
      fix: `Accept a revision of ${keys.join(', ')}; its traced criteria count once that revision is current.`,
    };
  }
  return {
    gap: `${f.linkedBy.join(', ')} ${f.linkedBy.length === 1 ? 'links' : 'link'} it, and none of their business criteria is traced to a step.`,
    fix: `Trace the business criteria its steps serve, on the requirements linking it: ${f.linkedBy
      .map((req) => criterionStepsCall(req, f.flow))
      .join('; ')}.`,
  };
}

/**
 * The answer every question about the steps takes where the newest revision changes only which
 * revision it follows: the approved revision it is carried from answered them, and a re-pin moves no
 * step, owner, trace or failure path (REQ-41 BC-23). Null for any other revision, which is asked all.
 */
function carriedFrom(f: DesignFacts): RecordAnswer | null {
  const approved = f.approved ? readStoredWorkflow(f.approved.raw) : null;
  const proposed = f.proposed?.document ?? null;
  if (!f.approved || !approved || !proposed || f.proposed?.revision === f.approved.revision) {
    return null;
  }
  const change = pinOnlyChange(approved, proposed, null);
  if (!change) return null;
  const pins = change.pins.map((p) => `${p.workflow} r${p.from} → r${p.to}`).join(', ');
  return {
    value: `Unchanged from revision ${f.approved.revision}, which was approved: this revision changes only which revision it follows (${pins}).`,
  };
}

/** The record answers of the workflow approval checklist, from what the design holds. */
export function approvalAnswersOf(f: DesignFacts): RecordAnswers {
  const doc = f.proposed?.document ?? null;
  const unreadable: RecordAnswer = {
    gap: 'Its newest revision is not a design this build reads.',
    fix: 'Write the design again in a shape the schema reads, and propose it.',
  };
  const carried = carriedFrom(f);
  if (carried && doc) {
    return {
      shape: { value: STRUCTURE_TEMPLATES.has(doc.template.id) ? 'structure' : 'flow' },
      criteria: carried,
      roles: carried,
      exceptions: carried,
      changes: changesOf(f),
    };
  }
  return {
    shape: doc
      ? { value: STRUCTURE_TEMPLATES.has(doc.template.id) ? 'structure' : 'flow' }
      : unreadable,
    criteria:
      f.linkedBy.length === 0
        ? { value: 'None: no requirement links it, so it serves no business criterion yet.' }
        : f.traced.length === 0
          ? untracedGap(f)
          : { value: `${f.traced.join(', ')} traced to its steps.`.slice(0, 2000) },
    roles: doc ? rolesOf(doc) : unreadable,
    exceptions: doc ? exceptionsOf(doc) : unreadable,
    changes: changesOf(f),
  };
}

/** What the design holds, read through `tx` under the workflow lock. */
export async function designFactsIn(tx: Tx, workflowId: string): Promise<DesignFacts> {
  const row = await readWorkflow(tx, workflowId);
  if (!row) throw new Error(`workflow checklist: workflow ${workflowId} has no row to read`);
  const designs = await designsOf(tx, workflowId);
  const newest = designs[0];
  const approved =
    row.approvedRevision === null
      ? undefined
      : designs.find((d) => d.revision === row.approvedRevision);
  const linked = (await tx.execute(sql`
    SELECT r.req_seq
      FROM requirement_workflows rw JOIN requirements r ON r.id = rw.requirement_id
     WHERE rw.workflow_id = ${workflowId} AND r.status <> 'dropped'
     ORDER BY r.req_seq
  `)) as unknown as Array<{ req_seq: number }>;
  const traced = (await tx.execute(sql`
    SELECT DISTINCT r.req_seq, s.code
      FROM requirement_criterion_steps s
      JOIN requirements r ON r.id = s.requirement_id AND r.status <> 'dropped'
      JOIN requirement_criteria c ON c.requirement_id = s.requirement_id AND c.code = s.code
       AND c.since_revision <= r.current_revision
       AND (c.retired_revision IS NULL OR c.retired_revision > r.current_revision)
     WHERE s.workflow_id = ${workflowId}
     ORDER BY r.req_seq, s.code
  `)) as unknown as Array<{ req_seq: number; code: string }>;
  const awaiting = (await tx.execute(sql`
    SELECT r.req_seq, count(DISTINCT s.code)::int AS traced
      FROM requirement_criterion_steps s
      JOIN requirements r ON r.id = s.requirement_id
       AND r.status <> 'dropped' AND r.current_revision IS NULL
     WHERE s.workflow_id = ${workflowId}
     GROUP BY r.req_seq
     ORDER BY r.req_seq
  `)) as unknown as Array<{ req_seq: number; traced: number }>;
  return {
    flow: row.flow,
    proposed: newest
      ? {
          revision: newest.revision,
          document: readStoredWorkflow(newest.document),
          raw: newest.document,
        }
      : null,
    approved: approved ? { revision: approved.revision, raw: approved.document } : null,
    linkedBy: linked.map((l) => requirementKey(Number(l.req_seq))),
    traced: traced.map((t) => `${requirementKey(Number(t.req_seq))} ${t.code}`),
    awaitingAccept: awaiting.map((a) => ({
      requirement: requirementKey(Number(a.req_seq)),
      traced: Number(a.traced),
    })),
  };
}

export async function workflowApprovalRecord(tx: Tx, workflowId: string): Promise<RecordAnswers> {
  return approvalAnswersOf(await designFactsIn(tx, workflowId));
}
