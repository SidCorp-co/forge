import {
  type BranchRefs,
  type LiveDivergence,
  resolveSourceHost,
  SourceHostUnavailable,
} from '../integrations/source-host/index.js';
import { readDeclaredSource } from '../project-config/index.js';

function noBinding(repository: string | null): string {
  if (!repository) {
    return "this project has no source host binding and its document declares no repository, so there are no branches to read — set `source.git.repository` with PUT /api/projects/:id/config and bind the repository's host on its Integrations page";
  }
  const host = repository.slice(0, repository.indexOf('/'));
  return `Forge holds no source host binding for this project's repository on ${host}, so it cannot read the branches — bind the repository's host on its Integrations page`;
}

/**
 * The commits on base that live lacks, read through the project's active source host binding. A
 * binding that exists and cannot be used is a refusal in its own words.
 */
export async function readProjectDivergence(
  projectId: string,
  refs: BranchRefs,
): Promise<LiveDivergence> {
  try {
    return await (await resolveSourceHost(projectId, 'kernel')).readDivergence(refs);
  } catch (err) {
    if (!(err instanceof SourceHostUnavailable)) throw err;
    if (err.reason !== 'no_binding') return { ok: false, reason: err.message };
  }
  return { ok: false, reason: noBinding((await readDeclaredSource(projectId)).repository) };
}
