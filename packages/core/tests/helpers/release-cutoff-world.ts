import type { ReleaseCutoff } from '@forge/contracts/release-cutoff';
import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';

/**
 * A world's release sweep cuts as soon as an outcome is eligible, as every sweep did before ISS-1126
 * made the release triggers policy (`@forge/contracts/release-cutoff`); `seedProjectDocument` declares
 * it unless the world names its own, and a world weighing the triggers declares them (`declareCutoff`).
 */
export const CUT_AT_ONCE: ReleaseCutoff = {
  triggers: [{ kind: 'time', minutes: 0 }, { kind: 'request' }],
};

/** The project document's `release.cutoff`, or none, so Forge's default reads. */
export async function declareCutoff(
  projectId: string,
  cutoff: ReleaseCutoff | null,
): Promise<void> {
  await db.execute(
    cutoff === null
      ? sql`UPDATE project_config_documents SET document = document #- '{release,cutoff}'
             WHERE project_id = ${projectId}`
      : sql`UPDATE project_config_documents
               SET document = jsonb_set(document, '{release,cutoff}', ${JSON.stringify(cutoff)}::jsonb)
             WHERE project_id = ${projectId}`,
  );
}
