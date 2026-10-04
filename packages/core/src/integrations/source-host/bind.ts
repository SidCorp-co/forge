import { forgeReads } from '../forge-reads.js';
import type { BindingTargetRefusal } from '../types.js';
import { hostOfRepository } from './resolve.js';

/** A binding on another host than the declared repository is refused as written, never at the merge. */
export async function sourceHostMismatch(args: {
  projectId: string;
  provider: string;
  host: string;
}): Promise<BindingTargetRefusal[]> {
  const repository = await forgeReads().declaredRepository(args.projectId);
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
