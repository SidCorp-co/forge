import { parseRepository } from '@forge/contracts/git-repository';
import type { BindingTargetRefusal } from '../index.js';
import { forgeReads } from '../index.js';
import { hostOfRepository } from './resolve.js';

/** A binding on another host than the declared repository is refused as written, never at the merge. */
export async function sourceHostMismatch(args: {
  projectId: string;
  provider: string;
  host: string;
}): Promise<BindingTargetRefusal[]> {
  const repository = await forgeReads().declaredRepository(args.projectId);
  if (repository && parseRepository(repository).kind === 'local') {
    return [
      {
        code: 'SOURCE_REPOSITORY_LOCAL',
        path: '',
        detail: `the project document declares its repository as the local path "${repository}", and a local path carries no webhooks and no merge detection by a host: this ${args.provider} binding on ${args.host} would watch and merge a repository the runners never push to. Declare the hosted repository (host.tld/owner/repo or git@host.tld:owner/repo) with PUT /api/projects/:id/config first; until then the default-branch head is read from a runner's bound checkout.`,
      },
    ];
  }
  const declared = hostOfRepository(repository);
  if (declared === null || declared === args.host.toLowerCase()) return [];
  return [
    {
      code: 'SOURCE_HOST_MISMATCH',
      path: '',
      detail: `this ${args.provider} binding reaches ${args.host}, and the project document declares its repository as "${repository}" on ${declared}: bind ${declared}'s own integration, or change \`source.git.repository\` with PUT /api/projects/:id/config first.`,
    },
  ];
}
