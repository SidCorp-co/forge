// A support project's master, made the way the product makes it (ISS-1041). A box a person pairs
// carries the project's own agent in its checkout (`devices/workspace-credential.ts:workspaceHolderFor`),
// which `conversations/handles.ts:resolveProjectHandle` mints with a handle on its org membership:
// that agent is also the handle every conversation of the project opens with. A bare agent user
// added as a member, with no org membership and so no handle, is a shape no door makes; it is taken
// for the project's handle while it is the oldest agent member, and every new thread is then refused
// HANDLE_HAS_NO_NAME and its message dropped, which is what hid ISS-1041's first message.

import { mintPat } from '../../src/credentials/pat.js';
import { PAT_GRANT_EPOCH } from '../../src/credentials/pat-permissions.js';

/** The project's master: its own agent, minted as a paired box mints it, and that agent's pane token. */
export async function supportMaster(projectId: string): Promise<{ userId: string; token: string }> {
  const { db } = await import('../../src/db/client.js');
  const { resolveProjectHandle } = await import('../../src/conversations/index.js');
  const handle = await db.transaction((tx) => resolveProjectHandle(tx, projectId));
  const pat = await mintPat({
    permissions: ['*'],
    userId: handle.userId,
    name: 'master',
    projectIds: [projectId],
    grantEpoch: PAT_GRANT_EPOCH,
  });
  return { userId: handle.userId, token: pat.plaintext };
}
