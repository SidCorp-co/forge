import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { type ProjectDocument, projectDocumentSchema } from '../../src/project-config/schema.js';
import { rows } from './factories.js';
import { seedProjectDocument } from './release-world.js';

/**
 * Controls a project declares in its document (REQ-79 r6: off unless declared): `gates` replaces
 * the gates block (profile standard unless named), `delivery` is merged in. Seeds a bare document where the project has none, and
 * a later `seedProjectDocument` keeps both.
 */
export async function declareControls(
  projectId: string,
  updatedBy: string,
  controls: {
    gates?: Partial<NonNullable<ProjectDocument['gates']>>;
    delivery?: ProjectDocument['delivery'];
  },
): Promise<void> {
  const [held] = await rows<{ document: ProjectDocument }>(
    sql`SELECT document FROM project_config_documents WHERE project_id = ${projectId}`,
  );
  // no source: a project that had no document keeps reading as hosting nothing
  if (!held) {
    await seedProjectDocument(projectId, updatedBy, { environments: {}, source: { type: 'none' } });
  }
  const [current] = await rows<{ document: ProjectDocument }>(
    sql`SELECT document FROM project_config_documents WHERE project_id = ${projectId}`,
  );
  if (!current)
    throw new Error(`declareControls: project ${projectId} holds no document after seeding`);
  const document = {
    ...current.document,
    ...(controls.gates ? { gates: { profile: 'standard', ...controls.gates } } : {}),
    ...(controls.delivery
      ? { delivery: { ...current.document.delivery, ...controls.delivery } }
      : {}),
  };
  await db.execute(sql`
    UPDATE project_config_documents
       SET document = ${JSON.stringify(projectDocumentSchema.parse(document))}::jsonb,
           revision = revision + 1
     WHERE project_id = ${projectId}
  `);
}
