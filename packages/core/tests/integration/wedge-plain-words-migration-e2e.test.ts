/**
 * Migration 0646, run by drizzle's own migrator over the rows the old code left (ISS-1184): a
 * stuck-work notice titled in the detector's words ("Pipeline wedge: claim hop miss on session")
 * and its bell row read as core writes one now, every hop and entity; its "WHERE/WHY/WHAT" body reads
 * as what was seen and what to do; and a notice in any other words is left as it was.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  WEDGE_ENTITIES,
  WEDGE_HOPS,
  wedgeBody,
  wedgeTitle,
} from '../../src/pipeline/wedge-words.js';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';

const TAG = '0646_a_stuck_work_notice_reads_in_plain_words';

let ground: MigrationGround;
let m: MigrationDb;
let reader: string;

beforeAll(async () => {
  ground = await groundBefore(TAG);
}, 120_000);

afterAll(async () => {
  await ground.drop();
});

beforeEach(async () => {
  m = await ground.fresh();
  reader = randomUUID();
  await m.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${reader}, ${`${reader}@forge.test`}, '!x', 'human')`;
});

afterEach(async () => {
  await m.drop();
});

async function notice(type: string, title: string, body: string | null): Promise<string> {
  const id = randomUUID();
  await m.sql`
    INSERT INTO notifications (id, project_id, type, kind, tier, state, title, body, severity)
    VALUES (${id}, NULL, ${type}, 'condition', 'ticket', 'firing', ${title}, ${body}, 'warning')
  `;
  const delivery = randomUUID();
  await m.sql`
    INSERT INTO notification_deliveries (id, user_id, channel, group_key, title)
    VALUES (${delivery}, ${reader}, 'bell', NULL, ${title})
  `;
  await m.sql`INSERT INTO notification_delivery_members (delivery_id, notification_id) VALUES (${delivery}, ${id})`;
  return id;
}

const read = async (id: string) => {
  const [n] = await m.sql<{ title: string; body: string | null; bell: string | null }[]>`
    SELECT n.title, n.body, d.title AS bell FROM notifications n
      JOIN notification_delivery_members dm ON dm.notification_id = n.id
      JOIN notification_deliveries d ON d.id = dm.delivery_id
     WHERE n.id = ${id}`;
  return n;
};

describe('a stuck-work notice written in the detector’s words reads in plain words', () => {
  it('rewrites every hop and entity’s title, on the notice and its bell row, as core writes one now', async () => {
    const ids = new Map<string, string>();
    for (const hop of WEDGE_HOPS) {
      for (const entity of WEDGE_ENTITIES) {
        ids.set(
          `${hop}:${entity}`,
          await notice('pipeline_wedge', `Pipeline wedge: ${hop} hop miss on ${entity}`, null),
        );
      }
    }
    await m.migrate();
    for (const hop of WEDGE_HOPS) {
      for (const entity of WEDGE_ENTITIES) {
        const row = await read(ids.get(`${hop}:${entity}`) as string);
        expect(row?.title, `${hop} × ${entity}`).toBe(wedgeTitle(hop, entity));
        expect(row?.bell, `${hop} × ${entity}, its bell row`).toBe(wedgeTitle(hop, entity));
      }
    }
  });

  it('rewrites the WHERE/WHY/WHAT body as what was seen and what to do, the raw id gone', async () => {
    const reason = 'no worker claimed the session within the queue timeout';
    const action = 'Check that an online runner is bound to this project.';
    const id = await notice(
      'pipeline_wedge',
      'Pipeline wedge: claim hop miss on session',
      `WHERE: claim hop, session 5b0c7a52-1f43-4c55-9d43-0d3c1a7f0e11\nWHY: ${reason}\nWHAT: ${action}`,
    );
    await m.migrate();
    const row = await read(id);
    expect(row?.body).toBe(wedgeBody({ reason, action }));
    expect(row?.body).not.toContain('5b0c7a52');
  });

  it('leaves a notice in any other words as it was', async () => {
    const own = await notice(
      'pipeline_wedge',
      'A release was cancelled because no machine picked it up',
      'Next: cut it again.',
    );
    const other = await notice('issue_stranded', 'Pipeline wedge: claim hop miss on session', null);
    await m.migrate();
    expect(await read(own)).toMatchObject({
      title: 'A release was cancelled because no machine picked it up',
      body: 'Next: cut it again.',
    });
    // a notice of another type keeps its title, and so does the bell row carrying it
    expect(await read(other)).toMatchObject({
      title: 'Pipeline wedge: claim hop miss on session',
      bell: 'Pipeline wedge: claim hop miss on session',
    });
  });
});
