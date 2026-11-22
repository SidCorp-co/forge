/**
 * The holder's close reads a criterion's fail as a release's close does (ISS-1397, debt 95bda276): a
 * fail recorded at or before the issue's latest reopen judged the build that reopen rejected, so it
 * holds the close back no more than a release's; a fail after the reopen still does.
 *
 * @direct-test-of packages/core/src/issues/close-in-scope.ts
 * @direct-test-of packages/core/src/issues/release-close-failing.ts
 */

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  close,
  failVerdict,
  landed,
  lease,
  refusalsOf,
  statusOf,
  useCloseScopeWorld,
} from '../helpers/close-scope-world.js';
import { rows } from '../helpers/factories.js';

useCloseScopeWorld();

describe("the holder's close over a fail its latest reopen voided (ISS-1397)", () => {
  it('closes over a fail its latest reopen voided, as a release does, and still refuses one after it', async () => {
    const reopened = async (id: string) => {
      await rows(sql`
        INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, actor_type, actor_agency, source, created_at)
        VALUES ('issue', ${id}, 'awaiting_release', 'reopen', 'system', 'agent', 'fixture', clock_timestamp())`);
      await rows(sql`UPDATE issues SET merged_at = clock_timestamp() WHERE id = ${id}`);
    };
    // the fail judged the build the reopen rejected: the fix landed since, and nothing fails this round
    const { id: voided } = await landed(['the field is listed', 'the field is sortable']);
    await failVerdict(voided, 2);
    await reopened(voided);
    await lease(voided);
    const r = await close(voided);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await statusOf(voided)).toBe('closed');

    const { id: failsAgain } = await landed(['the field is listed', 'the field is sortable']);
    await reopened(failsAgain);
    await failVerdict(failsAgain, 2);
    await lease(failsAgain);
    const again = await close(failsAgain);
    expect(again.status, JSON.stringify(again.json)).toBe(422);
    expect(refusalsOf(again)[0]?.code).toBe('CLOSE_CRITERION_UNPLACED');
    expect(refusalsOf(again)[0]?.detail).toContain('criterion 2: its newest verdict is a fail');
    expect(await statusOf(failsAgain)).toBe('awaiting_release');
  });
});
