/**
 * ISS-1229 r21 — the master's ruling: everywhere core names a member to other members it reads
 * personName — the display name, else "A member" — and never any part of their address.
 */

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createTestUser } from '../helpers/factories.js';
import { registerInboxFixture } from '../helpers/inbox-fixture.js';

const fx = registerInboxFixture();

async function owner(displayName: string | null, email: string): Promise<string> {
  const user = await createTestUser(fx.db, { email });
  await fx.db.execute(sql`
    UPDATE users SET display_name = ${displayName}, email_verified_at = now() WHERE id = ${user.id}
  `);
  return user.id;
}

describe('core names a member as personName calls them, never by address', () => {
  it.each([
    [null, 'A member'],
    ['lan.pham@example.com', 'A member'],
    [' Lan Pham ', 'Lan Pham'],
  ])(
    'a member whose display name is %j reads %j on every name core serves',
    async (given, called) => {
      const userId = await owner(given, 'lan.pham@example.com');
      const { resolveActors, userLabels } = await import('../../src/issues/actor-resolution.js');
      const { actorKey } = await import('../../src/issues/actor-identity.js');
      const { hydrateCreatorsForIssues } = await import('../../src/issues/creator.js');
      const { withDisplayNames, nameLostReaders, namePeople } = await import(
        '../../src/assistant/conversation-people.js'
      );
      const { personLabel } = await import('../../src/conversations/membership.js');
      const { db } = await import('../../src/db/client.js');

      const names = [
        (await resolveActors([{ type: 'user', id: userId }])).get(actorKey('user', userId))
          ?.displayName,
        (await userLabels([userId])).get(userId),
        (await hydrateCreatorsForIssues([{ id: 'i1', createdById: userId }])).get('i1')
          ?.creatorLabel,
        (await withDisplayNames([{ kind: 'person', userId, label: null }]))[0]?.displayName,
        (await nameLostReaders([{ losesReaderIds: [userId] }]))[0]?.losesReaders[0],
        (await namePeople([{ userId, email: 'lan.pham@example.com' }]))[0]?.displayName,
        await personLabel(db, userId),
      ];
      expect(names).toEqual(Array(names.length).fill(called));
      expect(JSON.stringify(names)).not.toContain('lan.pham');
    },
  );
});
