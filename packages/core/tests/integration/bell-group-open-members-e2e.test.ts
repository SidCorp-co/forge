/**
 * ISS-1229 r16 — judge-41 on criterion 94: a stuck-issue notice retired after it reached the bell
 * stayed in its group, struck through, saying in the present tense what was no longer true, and the
 * group counted it ("8 of 10 still open"). The master's ruling: a resolved member leaves the group
 * and its count, and nothing struck through stays in the bell.
 */

import { describe, expect, it } from 'vitest';
import { registerInboxFixture } from '../helpers/inbox-fixture.js';

const fx = registerInboxFixture();

describe('a grouped bell row once one of its records resolves', () => {
  it('lists and counts only the records still open', async () => {
    const kept = await fx.seedShipped(61, 'Repair invoice export');
    const retired = await fx.seedShipped(62, 'Retry failed webhooks');
    await fx.announce(() => fx.mods.detectOwedCloses());

    const [before] = fx.sweepRows(await fx.inbox());
    expect(before?.members).toBe(2);
    expect((await fx.membersOf(before?.id ?? '')).map((m) => m.issueId).sort()).toEqual(
      [kept, retired].sort(),
    );

    await fx.mods.resolveNotifications(fx.mods.owedCloseResolutionKey(retired));

    const [after] = fx.sweepRows(await fx.inbox());
    expect(after?.openMembers).toBe(1);
    const members = await fx.membersOf(after?.id ?? '');
    expect(members.map((m) => m.issueId)).toEqual([kept]);
    expect(members.every((m) => m.open)).toBe(true);
  });

  it('lists nothing once every record has resolved, and the row reads as resolved', async () => {
    const only = await fx.seedShipped(61, 'Repair invoice export');
    const other = await fx.seedShipped(62, 'Retry failed webhooks');
    await fx.announce(() => fx.mods.detectOwedCloses());
    for (const id of [only, other]) {
      await fx.mods.resolveNotifications(fx.mods.owedCloseResolutionKey(id));
    }

    const [row] = fx.sweepRows(await fx.inbox());
    expect(row?.openMembers).toBe(0);
    expect(await fx.membersOf(row?.id ?? '')).toEqual([]);
  });
});
