/**
 * The one writer. Every refusal a write can earn is raised here or below, so a
 * caller reaching this function inherits them without being told — the guard
 * on `sourceCommentId` sat beside the HTTP route instead, and the MCP tool,
 * which calls straight in, wrote the off-issue pointer that guard exists to
 * refuse and answered a missing id with the insert statement (ISS-1158). What
 * a door still owns is the rendering: which status carries which code.
 */

import { pgConstraintName, pgErrorCode } from '../../comments/error-mapping.js';
import { db } from '../../db/client.js';
import { loadIssueAttributes, type RenderedAttribute } from './read.js';
import { assertSourceCommentsOnIssue } from './source-comment.js';
import { AttributeRefusal, type AttributeWrite, writeAttributes } from './write.js';

/**
 * `ATTRIBUTE_REGISTRY` validates the write and the `issue_attribute_defs` seed
 * in migration 0245 carries the foreign key, and the two are kept in step by
 * hand. A key one holds and the other does not passes validation and then
 * breaks on this constraint, which reached a caller as the statement that
 * broke. Named here instead, because an operator told the two registries have
 * drifted can fix it and one told `23503` cannot.
 */
const DEFS_FK = 'issue_attributes_key_issue_attribute_defs_key_fk';

function driftRefusal(writes: readonly AttributeWrite[]): AttributeRefusal {
  const keys = writes.map((w) => w.key);
  return new AttributeRefusal(
    'ATTRIBUTE_DEF_MISSING',
    `no row in \`issue_attribute_defs\` for ${keys.map((k) => `\`${k}\``).join(', ')}, although this build's ATTRIBUTE_REGISTRY declares it — the code registry and the migration seed have drifted, and no write can land until they agree.`,
    { keys },
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
    if (pgErrorCode(err) === '23503' && pgConstraintName(err) === DEFS_FK)
      throw driftRefusal(writes);
    throw err;
  }
  const issueId = writes[0]?.issueId;
  return {
    written,
    attributes: issueId ? await loadIssueAttributes(issueId) : [],
  };
}
