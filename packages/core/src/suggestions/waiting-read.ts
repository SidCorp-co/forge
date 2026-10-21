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
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
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

/** Each target's key and short title, one set read per target type. */
async function targetsOf(projectId: string, rows: readonly Row[]): Promise<Map<string, Named>> {
  const ids = (type: SuggestionTargetType) => [
    ...new Set(rows.map(targetOfRow).flatMap((t) => (t.type === type ? [t.id] : []))),
  ];
  const [reqs, fbs, iss, flows, prefix] = await Promise.all([
    ids('requirement').length
      ? db
          .select({
            id: requirements.id,
            seq: requirements.reqSeq,
            title: sql<string>`coalesce(${requirements.shortName}, ${requirements.title})`,
          })
          .from(requirements)
          .where(inArray(requirements.id, ids('requirement')))
      : [],
    ids('feedback').length
      ? db
          .select({ id: feedback.id, seq: feedback.fbSeq, title: feedback.title })
          .from(feedback)
          .where(inArray(feedback.id, ids('feedback')))
      : [],
    ids('issue').length
      ? db
          .select({ id: issues.id, seq: issues.issSeq, title: issues.title })
          .from(issues)
          .where(inArray(issues.id, ids('issue')))
      : [],
    ids('workflow').length
      ? db
          .select({
            id: projectWorkflows.id,
            flow: projectWorkflows.flow,
            title: sql<string>`coalesce(${projectWorkflows.document}->>'title', ${projectWorkflows.flow})`,
          })
          .from(projectWorkflows)
          .where(inArray(projectWorkflows.id, ids('workflow')))
      : [],
    ids('issue').length ? activeIssuePrefix(projectId) : null,
  ]);
  const named = new Map<string, Named>();
  for (const r of reqs) named.set(r.id, { key: requirementKey(r.seq), title: r.title });
  for (const f of fbs) named.set(f.id, { key: feedbackKey(f.seq), title: f.title });
  for (const i of iss) named.set(i.id, { key: formatIssueRef(prefix, i.seq), title: i.title });
  for (const w of flows) named.set(w.id, { key: w.flow, title: w.title });
  return named;
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
  const rows = await db
    .select()
    .from(suggestions)
    .where(and(eq(suggestions.projectId, projectId), eq(suggestions.status, 'proposed')))
    .orderBy(asc(suggestions.createdAt));
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
