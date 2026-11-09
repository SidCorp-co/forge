// The suggestions of one project still waiting on a person, as the one Needs you read lists them: what
// each is on, by the key and the short title a reader knows it by, who produced it, and which of the
// two decisions the viewer may take (accept under its kind's gate, reject under suggestions.approve).
// A suggestion's payload is prose (a change summary, a note, a reason) and is never its title.

import { feedbackKey } from '@forge/contracts/feedback';
import type { ProjectPermission } from '@forge/contracts/permissions';
import { requirementKey } from '@forge/contracts/requirements';
import type {
  SuggestionKind,
  SuggestionProducer,
  SuggestionTargetType,
} from '@forge/contracts/suggestions';
import { and, asc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { memoizedPerId, rowsPerProject } from '../db/read-memo.js';
import { issues } from '../db/schema.js';
import { feedback } from '../db/schema-feedback.js';
import { requirements } from '../db/schema-requirements.js';
import { suggestions } from '../db/schema-suggestions.js';
import { projectWorkflows } from '../db/schema-workflows.js';
import { activeIssuePrefix } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { acceptGateOf } from './accept-gate.js';
import { type Row, targetOfRow } from './read.js';

export interface WaitingSuggestion {
  id: string;
  kind: SuggestionKind;
  /** What it is on: its id, its key, and its short title (a requirement's short name, else its title). */
  target: { type: SuggestionTargetType; id: string; key: string; title: string };
  /** What it proposes, as its kind's schema reads it (`SUGGESTION_PAYLOADS`); a reader parses it. */
  payload: unknown;
  producerKind: SuggestionProducer;
  producerId: string | null;
  createdAt: string;
  mayAccept: boolean;
  mayReject: boolean;
}

interface Named {
  key: string;
  title: string;
}

/** A target's number and short title, as each target type's read answers it. */
interface Titled {
  seq: number;
  title: string;
}

/**
 * Each target of one type by its number and short title. A target's row is its own, so every
 * project's suggestions a person's read asks before the quiet point are read in one statement of
 * each type (`db/read-memo.ts:memoizedPerId`, ISS-1070 r12): each was one a project.
 */
const titledOf = (
  type: 'requirement' | 'feedback' | 'issue',
  ids: readonly string[],
): Promise<Map<string, Titled>> =>
  ids.length === 0
    ? Promise.resolve(new Map())
    : memoizedPerId(`suggestionTarget:${type}`, ids, async (some) => {
        const rows =
          type === 'requirement'
            ? await db
                .select({
                  id: requirements.id,
                  seq: requirements.reqSeq,
                  title: sql<string>`coalesce(${requirements.shortName}, ${requirements.title})`,
                })
                .from(requirements)
                .where(inArray(requirements.id, [...some]))
            : type === 'feedback'
              ? await db
                  .select({ id: feedback.id, seq: feedback.fbSeq, title: feedback.title })
                  .from(feedback)
                  .where(inArray(feedback.id, [...some]))
              : await db
                  .select({ id: issues.id, seq: issues.issSeq, title: issues.title })
                  .from(issues)
                  .where(inArray(issues.id, [...some]));
        return new Map(rows.map(({ id, ...r }) => [id, r]));
      });

/** A workflow target's flow and title, as the suggestion's own row carries it where it was read with it. */
type FlowNamed = { flow: string; title: string };

/** A workflow's title, else its flow: what a reader names a design by. */
const flowTitle = sql<string>`coalesce(${projectWorkflows.document}->>'title', ${projectWorkflows.flow})`;

/**
 * Each target's key and short title, one set read per target type; a workflow a row was read with
 * (`workflowTarget`) is named from it.
 */
export async function targetsOf(
  projectId: string,
  rows: readonly (Row & { workflowTarget?: FlowNamed | null })[],
): Promise<Map<string, Named>> {
  const ids = (type: SuggestionTargetType) => [
    ...new Set(rows.map(targetOfRow).flatMap((t) => (t.type === type ? [t.id] : []))),
  ];
  const carried = new Map(
    rows.flatMap((r) =>
      r.workflowId && r.workflowTarget ? [[r.workflowId, r.workflowTarget]] : [],
    ),
  );
  const unread = ids('workflow').filter((id) => !carried.has(id));
  const [reqs, fbs, iss, flows, prefix] = await Promise.all([
    titledOf('requirement', ids('requirement')),
    titledOf('feedback', ids('feedback')),
    titledOf('issue', ids('issue')),
    unread.length
      ? db
          .select({ id: projectWorkflows.id, flow: projectWorkflows.flow, title: flowTitle })
          .from(projectWorkflows)
          .where(inArray(projectWorkflows.id, unread))
      : [],
    ids('issue').length ? activeIssuePrefix(projectId) : null,
  ]);
  const named = new Map<string, Named>();
  for (const [id, r] of reqs) named.set(id, { key: requirementKey(r.seq), title: r.title });
  for (const [id, f] of fbs) named.set(id, { key: feedbackKey(f.seq), title: f.title });
  for (const [id, i] of iss) named.set(id, { key: formatIssueRef(prefix, i.seq), title: i.title });
  for (const [id, w] of carried) named.set(id, { key: w.flow, title: w.title });
  for (const w of flows) named.set(w.id, { key: w.flow, title: w.title });
  return named;
}

/**
 * Every proposed suggestion of these projects, oldest first, each on a workflow with that
 * workflow's flow and title: a project's design changes named their workflows in a statement of
 * their own, a wave after the rows (ISS-1070 r20).
 */
function proposedRowsOf(projectIds: readonly string[]) {
  return db
    .select({
      ...getTableColumns(suggestions),
      // the outer row named as written: a single table's columns are sent unqualified
      workflowTarget: sql<FlowNamed | null>`(SELECT jsonb_build_object('flow', w.flow, 'title', coalesce(w.document->>'title', w.flow))
        FROM project_workflows w WHERE w.id = "suggestions"."workflow_id")`,
    })
    .from(suggestions)
    .where(and(inArray(suggestions.projectId, [...projectIds]), eq(suggestions.status, 'proposed')))
    .orderBy(asc(suggestions.createdAt));
}

/**
 * Every proposed suggestion of `projectId` the viewer may decide, oldest first. `holds` answers
 * whether the viewer holds a permission on the project; a suggestion they may neither accept nor
 * reject is left out, since it does not wait on them.
 */
export async function waitingSuggestionsFor(
  projectId: string,
  holds: (permission: ProjectPermission) => boolean,
): Promise<WaitingSuggestion[]> {
  const mayReject = holds('suggestions.approve');
  const breakdownGate = await acceptGateOf(projectId, 'breakdown');
  const mayBreakdown = holds(breakdownGate.permission);
  if (!mayReject && !mayBreakdown) return [];
  // every project's asks before the quiet point are one read (ISS-1070 r6)
  const rows = await rowsPerProject(
    'proposedSuggestionsOf',
    projectId,
    proposedRowsOf,
    (r) => r.projectId,
  );
  const named = await targetsOf(projectId, rows);
  return rows.flatMap((r): WaitingSuggestion[] => {
    const mayAccept = r.kind === 'breakdown' ? mayBreakdown : mayReject;
    if (!mayAccept && !mayReject) return [];
    const t = targetOfRow(r);
    const target = named.get(t.id);
    if (!target) {
      throw new Error(
        `suggestions: suggestion ${r.id} is on ${t.type} ${t.id}, which project ${projectId} does not hold`,
      );
    }
    return [
      {
        id: r.id,
        kind: r.kind,
        target: { type: t.type, id: t.id, ...target },
        payload: r.payload,
        producerKind: r.producerKind,
        producerId: r.producerId,
        createdAt: r.createdAt.toISOString(),
        mayAccept,
        mayReject,
      },
    ];
  });
}
