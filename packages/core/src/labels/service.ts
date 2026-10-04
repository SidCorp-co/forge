import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type LabelKind, labels } from '../db/schema.js';
import { autoModuleColor, deriveModuleSlug } from './module-service.js';
import { labelColumns } from './read.js';

/** A label or module, created on the project; a module takes a derived slug. */
export async function createLabel(
  projectId: string,
  input: {
    name: string;
    color?: string | undefined;
    kind?: LabelKind | undefined;
    parentId?: string | null | undefined;
    knowledgeEntryId?: string | null | undefined;
    description?: string | null | undefined;
  },
) {
  const isModule = (input.kind ?? 'label') === 'module';
  const [inserted] = await db
    .insert(labels)
    .values({
      projectId,
      name: input.name,
      color: input.color ?? autoModuleColor(input.name),
      kind: input.kind ?? 'label',
      parentId: input.parentId ?? null,
      slug: isModule ? await deriveModuleSlug(projectId, input.name) : null,
      knowledgeEntryId: input.knowledgeEntryId ?? null,
      description: input.description ?? null,
    })
    .returning(labelColumns);
  if (!inserted) throw new Error('labels: insert returned no row');
  return inserted;
}

/** One label, updated; null when absent. */
export async function updateLabel(labelId: string, updates: Record<string, unknown>) {
  const [updated] = await db
    .update(labels)
    .set(updates)
    .where(eq(labels.id, labelId))
    .returning(labelColumns);
  return updated ?? null;
}

/** One label, deleted. */
export async function deleteLabel(labelId: string): Promise<void> {
  await db.delete(labels).where(eq(labels.id, labelId));
}
