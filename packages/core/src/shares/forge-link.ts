// The one share target: a Forge link. It keeps the frozen document in `share_links` behind the hash of
// a fresh token and answers the link a reader opens; the token leaves this file only inside that
// link, shown once. No target hands a document to a third-party host (the owner's ruling).

import { type ShareTarget, sharePath } from '@forge/contracts/shares';
import { db } from '../db/client.js';
import { shareLinks } from '../db/schema.js';
import { env } from '../lib/env.js';
import { mintShareToken } from './token.js';

export const forgeLink: ShareTarget = {
  id: 'forge-link',
  hostedBy: 'forge',
  audiences: ['members', 'link'],
  async publish(input) {
    const { token, hash } = mintShareToken();
    const [row] = await db
      .insert(shareLinks)
      .values({
        projectId: input.projectId,
        tokenHash: hash,
        audience: input.audience,
        subjectKind: input.subjectKind,
        snapshot: input.document,
        createdBy: input.createdBy,
        expiresAt: input.expiresAt,
      })
      .returning({ id: shareLinks.id });
    if (!row) throw new Error('share_links: insert returned no row');
    return { id: row.id, url: `${env.APP_BASE_URL.replace(/\/+$/, '')}${sharePath(token)}` };
  },
};
