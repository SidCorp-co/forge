/**
 * Migration 0469, run by drizzle's own migrator: a memory whose writer a correction overwrote with
 * the person who corrected it names its writer again, read from the revision that correction made;
 * a row an agent rewrote since, a row never corrected and a corrector who was the writer stay as they
 * are; and from then on a decision's replaced text is kept as a revision like a note's (ISS-434).
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';

const TAG = '0469_a_corrected_memory_keeps_its_old_text_and_its_writer';

let ground: MigrationGround;
let m: MigrationDb;
let projectId: string;
const agent = randomUUID();
const person = randomUUID();
const other = randomUUID();

beforeAll(async () => {
  ground = await groundBefore(TAG);
}, 120_000);

afterAll(async () => {
  await ground.drop();
});

beforeEach(async () => {
  m = await ground.fresh();
  const orgId = randomUUID();
  projectId = randomUUID();
  for (const id of [agent, person, other]) {
    await m.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${id}, ${`${id}@forge.test`}, '!x', 'human')`;
  }
  await m.sql`INSERT INTO organizations (id, slug, name, is_personal, created_by) VALUES (${orgId}, ${`org-${orgId.slice(0, 8)}`}, 'Org', false, ${person})`;
  await m.sql`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${projectId}, ${`p-${projectId.slice(0, 8)}`}, 'HOP', ${orgId}, ${person})`;
});

afterEach(async () => {
  await m.drop();
});

/** A memory written with `metadata`, then corrected by `person` the way the old code did: writer overwritten. */
async function corrected(source: string, metadata: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  await m.sql`
    INSERT INTO memories (id, project_id, source, source_ref, text_content, metadata)
    VALUES (${id}, ${projectId}, ${source}, ${`ref/${id}`}, 'old text', ${m.sql.json(metadata as never)})
  `;
  const at = new Date(Date.now() - 60_000).toISOString();
  const after = {
    ...metadata,
    writtenBy: person,
    verifiedBy: person,
    corrections: [{ by: person, at, reason: 'checked it' }],
  };
  await m.sql`UPDATE memories SET text_content = 'new text', metadata = ${m.sql.json(after as never)} WHERE id = ${id}`;
  return id;
}

async function writerOf(id: string): Promise<string | null | undefined> {
  const [row] = await m.sql<
    { md: Record<string, unknown> }[]
  >`SELECT metadata AS md FROM memories WHERE id = ${id}`;
  return row?.md.writtenBy as string | null | undefined;
}

describe('0469: a corrected memory keeps its writer and its old text', () => {
  it('names the agent that wrote a corrected note again, read from the revision its correction made', async () => {
    const id = await corrected('note', { writtenBy: agent });
    expect(await writerOf(id)).toBe(person);
    await m.migrate();
    expect(await writerOf(id)).toBe(agent);
    const [row] = await m.sql<
      { md: Record<string, unknown> }[]
    >`SELECT metadata AS md FROM memories WHERE id = ${id}`;
    expect(row?.md.corrections).toEqual([expect.objectContaining({ by: person })]);
    expect(row?.md.verifiedBy).toBe(person);
  });

  it('leaves no writer where the row named none before its correction', async () => {
    const id = await corrected('note', {});
    await m.migrate();
    expect(await writerOf(id)).toBeUndefined();
  });

  it('leaves a row an agent rewrote since, a row never corrected, and a corrector who wrote it', async () => {
    const rewritten = await corrected('note', { writtenBy: agent });
    await m.sql`UPDATE memories SET metadata = jsonb_set(metadata, '{writtenBy}', ${m.sql.json(other as never)}) WHERE id = ${rewritten}`;
    const plain = randomUUID();
    await m.sql`
      INSERT INTO memories (id, project_id, source, source_ref, text_content, metadata)
      VALUES (${plain}, ${projectId}, 'note', 'ref/plain', 'text', ${m.sql.json({ writtenBy: agent } as never)})
    `;
    const own = await corrected('note', { writtenBy: person });
    await m.migrate();
    expect(await writerOf(rewritten)).toBe(other);
    expect(await writerOf(plain)).toBe(agent);
    expect(await writerOf(own)).toBe(person);
  });

  it('keeps a decision’s replaced text as a revision from now on, as it already did a note’s', async () => {
    const before = await corrected('decision', { writtenBy: agent });
    const [none] = await m.sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM memory_revisions WHERE memory_id = ${before}`;
    expect(none?.n).toBe(0);
    await m.migrate();
    await m.sql`UPDATE memories SET text_content = 'newer text' WHERE id = ${before}`;
    const revisions = await m.sql<
      { text_content: string }[]
    >`SELECT text_content FROM memory_revisions WHERE memory_id = ${before}`;
    expect(revisions.map((r) => r.text_content)).toEqual(['new text']);
    const mirror = randomUUID();
    await m.sql`
      INSERT INTO memories (id, project_id, source, source_ref, text_content)
      VALUES (${mirror}, ${projectId}, 'issue', ${randomUUID()}, 'issue text')
    `;
    await m.sql`UPDATE memories SET text_content = 'issue text, edited' WHERE id = ${mirror}`;
    const [mirrored] = await m.sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM memory_revisions WHERE memory_id = ${mirror}`;
    expect(mirrored?.n).toBe(0);
  });
});
