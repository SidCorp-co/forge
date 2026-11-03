// What each decision rests on (REQ-48 r3 BC-15), read from the records it opens and never from the
// asker's words: for an issue, the requirement and the revision it was planned against, whether it
// holds a plan, and its live criteria with the BC codes they trace; for a requirement, its current
// revision and its own live criteria. Two statements for the whole read, however many decisions.

import type { DecisionEvidence, NeedsYouDecision } from '@forge/contracts/needs-you-decisions';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { idList, rowsOf } from '../db/raw-sql.js';
import { clip } from './needs-you-decision-builders.js';

interface IssueFacts {
  id: string;
  has_plan: boolean;
  req_seq: number | null;
  req_title: string | null;
  revision: number | null;
  n: number;
  codes: string[] | null;
}

interface RequirementFacts {
  id: string;
  req_seq: number;
  title: string;
  revision: number | null;
  n: number;
  codes: string[] | null;
}

/** BC codes each once, in number order. */
const inOrder = (codes: readonly string[] | null) =>
  [...new Set(codes ?? [])].sort((a, b) => Number(a.slice(3)) - Number(b.slice(3))).slice(0, 40);

async function issueFacts(ids: readonly string[]): Promise<Map<string, DecisionEvidence>> {
  if (ids.length === 0) return new Map();
  const found = rowsOf<IssueFacts>(
    await db.execute(sql`
      SELECT i.id,
             (i.plan IS NOT NULL AND btrim(i.plan) <> '') AS has_plan,
             r.req_seq, r.title AS req_title,
             COALESCE(i.planned_revision, r.current_revision) AS revision,
             (SELECT count(*)::int FROM issue_criteria c
               WHERE c.issue_id = i.id AND c.retired_at IS NULL) AS n,
             (SELECT array_agg(DISTINCT rc.code) FROM issue_criteria c
                JOIN requirement_criteria rc ON rc.id = c.requirement_criterion_id
               WHERE c.issue_id = i.id AND c.retired_at IS NULL) AS codes
        FROM issues i
        LEFT JOIN requirements r ON r.id = i.requirement_id
       WHERE i.id IN (${idList(ids)})`),
  );
  return new Map(
    found.map((f) => [
      f.id,
      {
        requirement:
          f.req_seq === null
            ? null
            : {
                key: `REQ-${f.req_seq}`,
                title: clip(f.req_title ?? '', 500),
                revision: f.revision,
              },
        plan: f.has_plan,
        criteria: { count: f.n, codes: inOrder(f.codes) },
      },
    ]),
  );
}

async function requirementFacts(ids: readonly string[]): Promise<Map<string, DecisionEvidence>> {
  if (ids.length === 0) return new Map();
  const found = rowsOf<RequirementFacts>(
    await db.execute(sql`
      SELECT r.id, r.req_seq, r.title, r.current_revision AS revision,
             (SELECT count(*)::int FROM requirement_criteria rc
               WHERE rc.requirement_id = r.id AND rc.retired_revision IS NULL) AS n,
             (SELECT array_agg(rc.code) FROM requirement_criteria rc
               WHERE rc.requirement_id = r.id AND rc.retired_revision IS NULL) AS codes
        FROM requirements r
       WHERE r.id IN (${idList(ids)})`),
  );
  return new Map(
    found.map((f) => [
      f.id,
      {
        requirement: { key: `REQ-${f.req_seq}`, title: clip(f.title, 500), revision: f.revision },
        plan: null,
        criteria: { count: f.n, codes: inOrder(f.codes) },
      },
    ]),
  );
}

/** One project's decisions, and the ids its own read knows its issues and requirements by. */
export interface EvidenceGroup {
  decisions: readonly NeedsYouDecision[];
  ids: { issue: ReadonlyMap<string, string>; requirement: ReadonlyMap<string, string> };
}

const idOf = (d: NeedsYouDecision, ids: EvidenceGroup['ids']) =>
  d.opens?.kind === 'issue'
    ? ids.issue.get(d.opens.key)
    : d.opens?.kind === 'requirement'
      ? ids.requirement.get(d.opens.key)
      : undefined;

/**
 * Each group's decisions with the evidence of the issue or requirement each opens, where its read
 * knows the id; a decision about anything else is returned as it is. However many groups, it sends
 * at most two statements: the cross-project read hands every project's decisions in one call, so the
 * evidence costs it nothing a project (`tests/integration/read-memo-e2e.test.ts` bounds that).
 */
export async function withEvidence(
  groups: readonly EvidenceGroup[],
): Promise<NeedsYouDecision[][]> {
  const wanted = (kind: 'issue' | 'requirement') => [
    ...new Set(
      groups.flatMap((g) =>
        g.decisions.flatMap((d) => {
          const id = d.opens?.kind === kind ? idOf(d, g.ids) : undefined;
          return id ? [id] : [];
        }),
      ),
    ),
  ];
  const [issues, requirements] = await Promise.all([
    issueFacts(wanted('issue')),
    requirementFacts(wanted('requirement')),
  ]);
  return groups.map((g) =>
    g.decisions.map((d) => {
      const id = idOf(d, g.ids);
      const evidence = id
        ? d.opens?.kind === 'issue'
          ? issues.get(id)
          : requirements.get(id)
        : undefined;
      return evidence ? { ...d, evidence } : d;
    }),
  );
}
