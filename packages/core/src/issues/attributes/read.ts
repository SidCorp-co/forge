import { asc, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { issueAttributes, issues, projects, users } from '../../db/schema.js';
import { formatIssueRef } from '../../lib/issue-ref.js';
import { attributeDef } from './registry.js';
import { type AttributeRow, type RenderedAttribute, renderAttribute } from './render.js';

export type { AttributeRow, RenderedAttribute } from './render.js';

async function refLabels(rows: readonly AttributeRow[]): Promise<Map<string, string>> {
  const issueRefs = rows
    .filter((r) => attributeDef(r.key)?.valueType === 'ref_issue' && r.valueRef)
    .map((r) => r.valueRef as string);
  const userRefs = rows
    .filter((r) => attributeDef(r.key)?.valueType === 'ref_user' && r.valueRef)
    .map((r) => r.valueRef as string);
  const out = new Map<string, string>();
  if (issueRefs.length > 0)
    for (const row of await db
      .select({ id: issues.id, seq: issues.issSeq, prefix: projects.issuePrefix })
      .from(issues)
      .innerJoin(projects, eq(projects.id, issues.projectId))
      .where(inArray(issues.id, issueRefs)))
      out.set(row.id, formatIssueRef(row.prefix, row.seq));
  if (userRefs.length > 0)
    for (const row of await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(inArray(users.id, userRefs)))
      out.set(row.id, row.email);
  return out;
}

// cm:guard Returns what was asserted and nothing else. No state is computed here and none is stored: a derived value kept beside its evidence is a cached state, and a cached state is what lets a view drift from the record it came from (ISS-1010).
export async function loadIssueAttributes(issueUuid: string): Promise<RenderedAttribute[]> {
  const rows = (await db
    .select({
      key: issueAttributes.key,
      valueText: issueAttributes.valueText,
      valueNum: issueAttributes.valueNum,
      valueBool: issueAttributes.valueBool,
      valueTs: issueAttributes.valueTs,
      valueRef: issueAttributes.valueRef,
      sourceCommentId: issueAttributes.sourceCommentId,
      assertedByUserId: issueAttributes.assertedByUserId,
      assertedAt: issueAttributes.assertedAt,
    })
    .from(issueAttributes)
    .where(eq(issueAttributes.issueId, issueUuid))
    .orderBy(asc(issueAttributes.assertedAt))) as AttributeRow[];

  const labels = await refLabels(rows);
  return rows.map((r) => renderAttribute(r, labels));
}
