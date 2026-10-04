/** The one writer. Every refusal is raised here or below; a door renders it (ISS-1158). */

import { db } from '../../db/client.js';
import { pgConstraintName, pgErrorCode } from '../../lib/db-errors.js';
import { loadIssueAttributes, type RenderedAttribute } from './read.js';
import { assertSourceCommentsOnIssue } from './source-comment.js';
import { type AttributeWrite, writeAttributes } from './write.js';

/** The FK that fires when ATTRIBUTE_REGISTRY and migration 0245's seed have drifted. */
const DEFS_FK = 'issue_attributes_key_issue_attribute_defs_key_fk';

function driftError(writes: readonly AttributeWrite[]): Error {
  const keys = writes.map((w) => w.key);
  return new Error(
    `no row in \`issue_attribute_defs\` for ${keys.map((k) => `\`${k}\``).join(', ')}, although this build's ATTRIBUTE_REGISTRY declares it — the code registry and the migration seed have drifted, and no write can land until they agree.`,
  );
}

/** One transaction: `writeAttributes` deletes a cardinality-one row before inserting, so on the raw handle a later refusal in the same batch left the old value gone and nothing in its place. */
export async function setIssueAttributes(
  writes: readonly AttributeWrite[],
): Promise<{ written: number; attributes: RenderedAttribute[] }> {
  let written: number;
  try {
    written = await db.transaction(async (tx) => {
      await assertSourceCommentsOnIssue(writes, tx);
      return writeAttributes(writes, tx);
    });
  } catch (err) {
    if (pgErrorCode(err) === '23503' && pgConstraintName(err) === DEFS_FK) throw driftError(writes);
    throw err;
  }
  const issueId = writes[0]?.issueId;
  return {
    written,
    attributes: issueId ? await loadIssueAttributes(issueId) : [],
  };
}
