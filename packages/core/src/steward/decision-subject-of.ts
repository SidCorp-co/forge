// The item a steward decision question is about, by the key the run names (REQ-48 BC-5): an issue
// key, REQ-n or FB-n of the project. A key naming none is refused by name, so no question is asked
// about an item that is not there.

import type { StewardDecisionSubject, StewardRefusalCode } from '@forge/contracts/steward';
import { db } from '../db/client.js';
import { rowIn as feedbackRowIn } from '../feedback/index.js';
import { issueIdOfKey } from '../issues/index.js';
import { refuser } from '../lib/refusal.js';
import { requirementIdIn } from '../requirements/index.js';

const refuse = refuser<StewardRefusalCode>('STEWARD_DECISION_SUBJECT_UNKNOWN');

/** The item a key names in the project, or a refusal naming the key. */
export async function decisionSubjectOf(
  projectId: string,
  key: string,
): Promise<{ kind: StewardDecisionSubject; id: string }> {
  if (/^REQ-\d+$/i.test(key)) {
    const id = await requirementIdIn(db, projectId, key);
    if (id) return { kind: 'requirement', id };
  } else if (/^FB-\d+$/i.test(key)) {
    const row = await feedbackRowIn(db, projectId, key).catch(() => null);
    if (row) return { kind: 'feedback', id: row.id };
  } else {
    const id = await issueIdOfKey(key, projectId);
    if (id) return { kind: 'issue', id };
  }
  throw refuse(
    'STEWARD_DECISION_SUBJECT_UNKNOWN',
    `${key} names no issue, requirement or feedback item of this project`,
    '/about',
  );
}
