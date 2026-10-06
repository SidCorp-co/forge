/**
 * Migration 0424, run by drizzle's own migrator over the rows the old code left. Two halves:
 * a requirement revision records whether a person or an agent wrote it, backfilled from its author's
 * account kind and frozen with the rest of its content once it leaves draft (F8); and the bell rows
 * the old code founded per sweep minute, or per undeliverable question, fold into one open row per
 * reader and project, unread while any row folded into it was unread (F10, F12).
 */

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';

const TAG = '0424_a_revision_names_who_wrote_it_and_a_projects_strands_share_one_bell_row';

let ground: MigrationGround;
let m: MigrationDb;
let person: string;
let agent: string;
let projectId: string;
let orgId: string;

beforeAll(async () => {
  ground = await groundBefore(TAG);
}, 120_000);

afterAll(async () => {
  await ground.drop();
});

async function user(db: postgres.Sql, kind: 'human' | 'agent'): Promise<string> {
  const id = randomUUID();
  await db`INSERT INTO users (id, email, password_hash, kind) VALUES (${id}, ${`${id}@forge.test`}, '!x', ${kind})`;
  return id;
}

async function project(db: postgres.Sql, name: string): Promise<string> {
  const id = randomUUID();
  await db`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${id}, ${`p-${id.slice(0, 8)}`}, ${name}, ${orgId}, ${person})`;
  return id;
}

beforeEach(async () => {
  m = await ground.fresh();
  person = await user(m.sql, 'human');
  agent = await user(m.sql, 'agent');
  orgId = randomUUID();
  await m.sql`INSERT INTO organizations (id, slug, name, is_personal, created_by) VALUES (${orgId}, ${`org-${orgId.slice(0, 8)}`}, 'Org', false, ${person})`;
  projectId = await project(m.sql, 'Atlas');
});

afterEach(async () => {
  await m.drop();
});

/** The database's own words for a refused write. */
async function refusedBy(write: Promise<unknown>): Promise<string> {
  try {
    await write;
  } catch (err) {
    return String((err as Error).message);
  }
  throw new Error('the write was not refused');
}

describe('a revision names whether a person or an agent wrote it', () => {
  let seq = 0;

  async function revision(authorId: string, state: 'draft' | 'proposed'): Promise<string> {
    const id = randomUUID();
    seq += 1;
    await m.sql`INSERT INTO requirements (id, project_id, req_seq, title) VALUES (${id}, ${projectId}, ${seq}, ${`req ${seq}`})`;
    await m.sql`
      INSERT INTO requirement_revisions (requirement_id, revision, state, spec, reason, author_id, proposed_at, proposed_by)
      VALUES (${id}, 1, ${state}, '{}'::jsonb, 'first cut', ${authorId},
              ${state === 'proposed' ? new Date() : null}, ${state === 'proposed' ? authorId : null})
    `;
    return id;
  }

  const agencyOf = async (id: string) =>
    (
      await m.sql<Array<{ author_agency: string }>>`
        SELECT author_agency FROM requirement_revisions WHERE requirement_id = ${id}
      `
    )[0]?.author_agency;

  it('backfills each existing revision from its author account’s kind', async () => {
    const byPerson = await revision(person, 'proposed');
    const byAgent = await revision(agent, 'draft');

    await m.migrate();

    expect(await agencyOf(byPerson)).toBe('human');
    expect(await agencyOf(byAgent)).toBe('agent');
  });

  it('refuses a revision naming no agency, or one outside human and agent', async () => {
    await m.migrate();
    const id = randomUUID();
    await m.sql`INSERT INTO requirements (id, project_id, req_seq, title) VALUES (${id}, ${projectId}, 99, 'new')`;
    const write = (agency: string | null) =>
      m.sql`
        INSERT INTO requirement_revisions (requirement_id, revision, spec, reason, author_id, author_agency)
        VALUES (${id}, 1, '{}'::jsonb, 'r', ${person}, ${agency})
      `;

    expect(await refusedBy(write(null))).toMatch(/author_agency/);
    expect(await refusedBy(write('robot'))).toMatch(/requirement_revisions_author_agency_chk/);
  });

  it('freezes the agency with the rest of a revision once it leaves draft', async () => {
    const proposed = await revision(person, 'proposed');
    const draft = await revision(person, 'draft');
    await m.migrate();

    expect(
      await refusedBy(
        m.sql`UPDATE requirement_revisions SET author_agency = 'agent' WHERE requirement_id = ${proposed}`,
      ),
    ).toMatch(
      /^REVISION_IMMUTABLE: requirement .* revision 1 is proposed, so its content is frozen/,
    );
    expect(await agencyOf(proposed)).toBe('human');

    await m.sql`UPDATE requirement_revisions SET author_agency = 'agent' WHERE requirement_id = ${draft}`;
    expect(await agencyOf(draft)).toBe('agent');
  });
});

interface Delivery {
  id: string;
  group_key: string | null;
  title: string | null;
  read_at: Date | null;
  members: string[];
}

async function deliveriesOf(reader: string): Promise<Delivery[]> {
  return m.sql<Delivery[]>`
    SELECT d.id, d.group_key, d.title, d.read_at,
           coalesce(array_agg(dm.notification_id::text ORDER BY dm.notification_id)
                    FILTER (WHERE dm.notification_id IS NOT NULL), '{}') AS members
      FROM notification_deliveries d
      LEFT JOIN notification_delivery_members dm ON dm.delivery_id = d.id
     WHERE d.user_id = ${reader}
     GROUP BY d.id
     ORDER BY d.group_key NULLS FIRST, d.created_at
  `;
}

async function notice(
  project: string | null,
  resolutionKey: string | null = null,
): Promise<string> {
  const id = randomUUID();
  await m.sql`
    INSERT INTO notifications (id, project_id, type, kind, tier, state, title, severity, resolution_key)
    VALUES (${id}, ${project}, 'issue_stranded', 'condition', 'ticket', 'firing', 'stranded', 'warning', ${resolutionKey})
  `;
  return id;
}

async function delivery(args: {
  reader: string;
  groupKey: string | null;
  members: string[];
  readAt?: Date | null;
  resolvedNotice?: boolean;
  title?: string;
}): Promise<string> {
  const id = randomUUID();
  await m.sql`
    INSERT INTO notification_deliveries (id, user_id, channel, group_key, title, read_at, resolved_notice)
    VALUES (${id}, ${args.reader}, 'bell', ${args.groupKey}, ${args.title ?? 'Idle issues'},
            ${args.readAt ?? null}, ${args.resolvedNotice ?? false})
  `;
  for (const n of args.members) {
    await m.sql`INSERT INTO notification_delivery_members (delivery_id, notification_id) VALUES (${id}, ${n})`;
  }
  return id;
}

const sorted = (ids: string[]) => [...ids].sort();

describe('a project’s strands share one bell row', () => {
  it('folds the per-minute rows of one detector into one row per reader and project', async () => {
    const a = await notice(projectId);
    const b = await notice(projectId);
    const read = new Date('2026-09-01T10:00:00Z');
    await delivery({
      reader: person,
      groupKey: 'sweep:idle-issues:29280001',
      members: [a],
      readAt: read,
    });
    await delivery({ reader: person, groupKey: 'sweep:idle-issues:29280002', members: [b] });

    await m.migrate();

    const after = await deliveriesOf(person);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ group_key: `sweep:idle-issues:${projectId}`, read_at: null });
    expect(after[0]?.members).toEqual(sorted([a, b]));
  });

  it('reads the folded row as read only when every row folded into it was, at the latest read', async () => {
    const a = await notice(projectId);
    const b = await notice(projectId);
    const early = new Date('2026-09-01T10:00:00Z');
    const late = new Date('2026-09-01T11:00:00Z');
    await delivery({
      reader: person,
      groupKey: 'sweep:idle-issues:29280001',
      members: [a],
      readAt: early,
    });
    await delivery({
      reader: person,
      groupKey: 'sweep:idle-issues:29280002',
      members: [b],
      readAt: late,
    });

    await m.migrate();

    const [row] = await deliveriesOf(person);
    expect(row?.read_at?.toISOString()).toBe(late.toISOString());
  });

  it('keeps detectors, projects and readers apart', async () => {
    const other = await project(m.sql, 'Borealis');
    const idleHere = await notice(projectId);
    const idleThere = await notice(other);
    const orphan = await notice(projectId);
    await delivery({
      reader: person,
      groupKey: 'sweep:idle-issues:29280001',
      members: [idleHere, idleThere],
    });
    await delivery({
      reader: person,
      groupKey: 'sweep:orphan-assertion:29280001',
      members: [orphan],
    });
    await delivery({ reader: agent, groupKey: 'sweep:idle-issues:29280001', members: [idleHere] });

    await m.migrate();

    expect((await deliveriesOf(person)).map((d) => [d.group_key, d.members])).toEqual(
      expect.arrayContaining([
        [`sweep:idle-issues:${projectId}`, [idleHere]],
        [`sweep:idle-issues:${other}`, [idleThere]],
        [`sweep:orphan-assertion:${projectId}`, [orphan]],
      ]),
    );
    expect(await deliveriesOf(person)).toHaveLength(3);
    expect((await deliveriesOf(agent)).map((d) => d.group_key)).toEqual([
      `sweep:idle-issues:${projectId}`,
    ]);
  });

  it('leaves a row carrying a record with no project, a resolved notice, and an already-folded key as they were', async () => {
    const projectless = await notice(null);
    const withProject = await notice(projectId);
    const resolved = await notice(projectId);
    const mixed = await delivery({
      reader: person,
      groupKey: 'sweep:idle-issues:29280001',
      members: [projectless, withProject],
    });
    const notice2 = await delivery({
      reader: person,
      groupKey: 'sweep:idle-issues:29280003',
      members: [resolved],
      resolvedNotice: true,
    });

    await m.migrate();

    const ids = (await deliveriesOf(person)).map((d) => d.id);
    expect(sorted(ids)).toEqual(sorted([mixed, notice2]));
  });
});

describe('an undeliverable question shares one bell row per reason', () => {
  async function undeliverable(lastError: string): Promise<string> {
    const question = randomUUID();
    await m.sql`
      INSERT INTO agent_questions (id, project_id, blocker_kind, steps)
      VALUES (${question}, ${projectId}, 'human', '[]'::jsonb)
    `;
    await m.sql`
      INSERT INTO rocketchat_question_deliveries (question_id, round, status, last_error)
      VALUES (${question}, 1, 'undeliverable', ${lastError})
    `;
    return notice(projectId, `rocketchat-question-undeliverable:${question}`);
  }

  it('folds the ungrouped rows into one per reader, project and reason, titled with the reason', async () => {
    const a = await undeliverable('no room is bound');
    const b = await undeliverable('no room is bound');
    const c = await undeliverable('the bot was removed');
    for (const n of [a, b, c])
      await delivery({ reader: person, groupKey: null, members: [n], title: 'q' });

    await m.migrate();

    const after = await deliveriesOf(person);
    expect(after.map((d) => [d.group_key, d.title, d.members])).toEqual(
      expect.arrayContaining([
        [
          `question-undeliverable:${projectId}:no room is bound`,
          'Atlas: questions are not posted to chat — no room is bound',
          sorted([a, b]),
        ],
        [
          `question-undeliverable:${projectId}:the bot was removed`,
          'Atlas: questions are not posted to chat — the bot was removed',
          [c],
        ],
      ]),
    );
    expect(after).toHaveLength(2);
  });

  it('leaves an ungrouped row of another kind alone', async () => {
    const plain = await notice(projectId, 'something-else:1');
    const id = await delivery({ reader: person, groupKey: null, members: [plain] });

    await m.migrate();

    expect((await deliveriesOf(person)).map((d) => d.id)).toEqual([id]);
  });
});
