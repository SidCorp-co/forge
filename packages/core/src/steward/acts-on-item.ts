// Which item a steward act changed, whatever run took it (REQ-48 BC-12, ISS-618 c4): FB-180's run
// linked ISS-603 to REQ-10, wrote its plan and criteria and asked on it, and the item pages of
// ISS-603 and REQ-10 read none of it, since acts were read by their run's subject alone.

import { feedbackKey } from '@forge/contracts/feedback';
import { requirementKey } from '@forge/contracts/requirements';
import { and, eq, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { feedback } from '../db/schema-feedback.js';
import { requirements } from '../db/schema-requirements.js';
import { stewardActs } from '../db/schema-steward-runs.js';
import { issueIdOfKey } from '../issues/index.js';

/** The id of the item a key names in this project: a requirement, a feedback item or an issue. */
export async function itemIdOfKey(projectId: string, key: string): Promise<string | null> {
  const req = /^REQ-(\d+)$/.exec(key);
  if (req) {
    const [row] = await db
      .select({ id: requirements.id })
      .from(requirements)
      .where(and(eq(requirements.projectId, projectId), eq(requirements.reqSeq, Number(req[1]))))
      .limit(1);
    return row && requirementKey(Number(req[1])) === key ? row.id : null;
  }
  const fb = /^FB-(\d+)$/.exec(key);
  if (fb) {
    const [row] = await db
      .select({ id: feedback.id })
      .from(feedback)
      .where(and(eq(feedback.projectId, projectId), eq(feedback.fbSeq, Number(fb[1]))))
      .limit(1);
    return row && feedbackKey(Number(fb[1])) === key ? row.id : null;
  }
  return issueIdOfKey(key, projectId);
}

/** A path segment that is exactly `ref`, as a regular expression over a door. */
const segment = (ref: string): SQL => sql`${`/${ref.replace(/[^A-Za-z0-9-]/g, '')}(/|$)`}`;

/**
 * Whether an act changed the item `key` (id `itemId`): the record it says it wrote is that item; its
 * door or its undo's door names the item in its path (`PATCH /api/issues/<id>`,
 * `POST …/requirements/REQ-10/issues` and its undo `DELETE …/REQ-10/issues/<issue id>`); or the
 * question it asked is about that item.
 */
export function actTouchesSql(key: string, itemId: string | null): SQL {
  const byPath = (ref: string) => sql`(
    ${stewardActs.door} ~ ${segment(ref)} OR coalesce(${stewardActs.undo} ->> 'door', '') ~ ${segment(ref)})`;
  const asked = itemId
    ? sql`(${stewardActs.wrote} ->> 'kind' = 'question' AND EXISTS (
        SELECT 1 FROM agent_questions q
         WHERE q.id::text = ${stewardActs.wrote} ->> 'ref'
           AND (q.issue_id = ${itemId}::uuid OR q.requirement_id = ${itemId}::uuid
                OR q.feedback_id = ${itemId}::uuid)))`
    : sql`false`;
  return sql`(${stewardActs.wrote} ->> 'ref' = ${key} OR ${byPath(key)}
    ${itemId ? sql`OR ${byPath(itemId)}` : sql``} OR ${asked})`;
}
