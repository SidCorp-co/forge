// The suggestions of one project still waiting on a person, as the approval inbox lists them: what
// each is on by the key a reader knows, its writer's own words, who produced it, and which of the
// two decisions the viewer may take (accept under its kind's gate, reject under suggestions.approve).

import { feedbackKey } from '@forge/contracts/feedback';
import type { ProjectPermission } from '@forge/contracts/permissions';
import { requirementKey } from '@forge/contracts/requirements';
import type {
  SuggestionKind,
  SuggestionProducer,
  SuggestionTargetType,
} from '@forge/contracts/suggestions';
import { and, asc, eq, inArray } from 'drizzle-orm';
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
  target: { type: SuggestionTargetType; key: string };
  /** The writer's words the payload leads with; empty where its kind carries none. */
  title: string;
  producerKind: SuggestionProducer;
  producerId: string | null;
  createdAt: string;
  mayAccept: boolean;
  mayReject: boolean;
}

/** The fields a payload's own words sit in, in the order a reader is shown the first one present. */
const WORDS = ['title', 'changeSummary', 'tldr', 'note', 'answer', 'reason'] as const;

export function wordsOf(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const p = payload as Record<string, unknown>;
  for (const field of WORDS) {
    const v = p[field];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

async function targetKeysOf(projectId: string, rows: readonly Row[]): Promise<Map<string, string>> {
  const ids = (type: SuggestionTargetType) => [
    ...new Set(rows.map(targetOfRow).flatMap((t) => (t.type === type ? [t.id] : []))),
  ];
  const [reqs, fbs, iss, flows, prefix] = await Promise.all([
    ids('requirement').length
      ? db
          .select({ id: requirements.id, seq: requirements.reqSeq })
          .from(requirements)
          .where(inArray(requirements.id, ids('requirement')))
      : [],
    ids('feedback').length
      ? db
          .select({ id: feedback.id, seq: feedback.fbSeq })
          .from(feedback)
          .where(inArray(feedback.id, ids('feedback')))
      : [],
    ids('issue').length
      ? db
          .select({ id: issues.id, seq: issues.issSeq })
          .from(issues)
          .where(inArray(issues.id, ids('issue')))
      : [],
    ids('workflow').length
      ? db
          .select({ id: projectWorkflows.id, flow: projectWorkflows.flow })
          .from(projectWorkflows)
          .where(inArray(projectWorkflows.id, ids('workflow')))
      : [],
    ids('issue').length ? activeIssuePrefix(projectId) : null,
  ]);
  const keys = new Map<string, string>();
  for (const r of reqs) keys.set(r.id, requirementKey(r.seq));
  for (const f of fbs) keys.set(f.id, feedbackKey(f.seq));
  for (const i of iss) keys.set(i.id, formatIssueRef(prefix, i.seq));
  for (const w of flows) keys.set(w.id, w.flow);
  return keys;
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
  const keys = await targetKeysOf(projectId, rows);
  return rows.flatMap((r): WaitingSuggestion[] => {
    const mayAccept = r.kind === 'breakdown' ? mayBreakdown : mayReject;
    if (!mayAccept && !mayReject) return [];
    const t = targetOfRow(r);
    const key = keys.get(t.id);
    if (!key) {
      throw new Error(
        `suggestions: suggestion ${r.id} is on ${t.type} ${t.id}, which project ${projectId} does not hold`,
      );
    }
    return [
      {
        id: r.id,
        kind: r.kind,
        target: { type: t.type, key },
        title: wordsOf(r.payload),
        producerKind: r.producerKind,
        producerId: r.producerId,
        createdAt: r.createdAt.toISOString(),
        mayAccept,
        mayReject,
      },
    ];
  });
}
