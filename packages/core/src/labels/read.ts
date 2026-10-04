import { count, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueLabels, labels } from '../db/schema.js';

export const labelColumns = {
  id: labels.id,
  projectId: labels.projectId,
  name: labels.name,
  color: labels.color,
  kind: labels.kind,
  parentId: labels.parentId,
  slug: labels.slug,
  knowledgeEntryId: labels.knowledgeEntryId,
  description: labels.description,
  createdAt: labels.createdAt,
};

/** Every label and module of the project. */
export async function listProjectLabels(projectId: string) {
  return db.select(labelColumns).from(labels).where(eq(labels.projectId, projectId));
}

/** What an edit of one label needs to read first; null when absent. */
export async function labelHead(labelId: string) {
  const [row] = await db
    .select({
      id: labels.id,
      projectId: labels.projectId,
      name: labels.name,
      kind: labels.kind,
      parentId: labels.parentId,
    })
    .from(labels)
    .where(eq(labels.id, labelId))
    .limit(1);
  return row ?? null;
}

/** How many issues carry the label. */
export async function labelAttachmentCount(labelId: string): Promise<number> {
  const [attached] = await db
    .select({ n: count() })
    .from(issueLabels)
    .where(eq(issueLabels.labelId, labelId));
  return attached?.n ?? 0;
}
