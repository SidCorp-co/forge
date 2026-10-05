// The people a "needs a human decision" notification must reach: the holders of project.admin.

import { holdersOf } from '../permissions/index.js';

/** Every id asked for is a key, mapping to the empty array where the project has no admin or does not exist. */
export function projectAdminUserIdsFor(
  projectIds: readonly string[],
): Promise<Map<string, string[]>> {
  return holdersOf('project.admin', projectIds);
}

export async function projectAdminUserIds(projectId: string): Promise<string[]> {
  const byProject = await projectAdminUserIdsFor([projectId]);
  return byProject.get(projectId) ?? [];
}
