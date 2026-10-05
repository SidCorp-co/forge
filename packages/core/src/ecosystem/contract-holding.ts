import { and, desc, eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { projects } from '../db/schema.js';
import { contractVersions } from '../db/schema-ecosystem.js';

/** How many recorded versions are listed when the one named is not among them. */
const VERSIONS_LISTED = 10;

/** What a project holds for a contract a verdict names: its slug, and the versions it recorded. */
export async function contractHolding(
  projectId: string,
  named: { readonly project: string; readonly contract: string; readonly version: string },
  tx: Tx,
) {
  const [project] = await tx
    .select({ slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const projectSlug = project?.slug ?? '';
  if (projectSlug !== named.project) return { projectSlug, versions: [], named: false };
  const rows = await tx
    .select({ version: contractVersions.version })
    .from(contractVersions)
    .where(
      and(
        eq(contractVersions.providerProjectId, projectId),
        eq(contractVersions.contractSlug, named.contract),
      ),
    )
    .orderBy(desc(contractVersions.recordedAt));
  const versions = rows.map((r) => r.version);
  return {
    projectSlug,
    versions: versions.slice(0, VERSIONS_LISTED),
    named: versions.includes(named.version),
  };
}
