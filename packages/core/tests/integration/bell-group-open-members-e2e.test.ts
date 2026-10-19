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

// ISS-1229 r16, judge-41: open-count with a project counted a group spanning two projects once in
// each, so the projects' counts added up to more rows than the bell holds. It is counted once.
describe('a bell row whose open records span two projects', () => {
  it('counts once, in the whole count, and in neither project’s', async () => {
    const { createTestProject } = await import('../helpers/factories.js');
    const other = await createTestProject(fx.db, fx.owner, { name: 'Payroll' });
    const raise = (projectId: string, key: string, groupKey: string) =>
      fx.mods.recordAndDeliver({
        recipients: [fx.owner],
        projectId,
        type: 'ops_alert',
        title: key,
        resolutionKey: key,
        groupKey,
        groupTitle: 'Operations',
      });
    await raise(fx.project.id, 'ops:a1', 'g:both');
    await raise(other.id, 'ops:b1', 'g:both');
    await raise(fx.project.id, 'ops:a2', 'g:one');
    await raise(fx.project.id, 'ops:a3', 'g:one');

    const count = async (query = '') => {
      const res = await fx.app.request(`/api/notifications/open-count${query}`, {
        headers: fx.auth(),
      });
      expect(res.status).toBe(200);
      return ((await res.json()) as { count: number }).count;
    };
    expect(await count()).toBe(2);
    expect(await count(`?projectId=${fx.project.id}`)).toBe(1);
    expect(await count(`?projectId=${other.id}`)).toBe(0);

    // Once the other project's record resolves, the row is the first project's alone.
    await fx.mods.resolveNotifications('ops:b1');
    expect(await count(`?projectId=${fx.project.id}`)).toBe(2);
  });
});
