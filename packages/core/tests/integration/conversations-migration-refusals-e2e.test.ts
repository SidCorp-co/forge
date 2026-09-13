/**
 * ISS-1001 — `0239_conversations.sql`'s two ways of saying no, walked against a
 * real Postgres: a source row the new schema cannot represent, and the
 * assertion block that checks the copy it just made.
 *
 * The omission cases are the point of the assertion block. Each one runs the
 * real statement list with ONE statement removed or corrupted and requires the
 * migration to abort naming the source session, before `chat_sessions` is
 * dropped. Without them, the assertion is a block that has never been observed
 * to say no.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  conversations,
  type PreMigrationGround,
  plantProject,
  plantSession,
  preMigrationGround,
  runForward,
} from './conversations-migration-ground.js';

let ground: PreMigrationGround;

beforeAll(async () => {
  ground = await preMigrationGround();
}, 300_000);

afterAll(async () => {
  if (ground) await ground.stop();
});

const freshDb = () => ground.fresh();

describe('0239 forward — a row it cannot represent stops the deploy', () => {
  it('aborts naming the session whose messages are not an array, and keeps the table', async () => {
    const db = await freshDb();
    try {
      const { projectId } = await plantProject(db.sql, 'forge-dev');
      const good = await plantSession(db.sql, {
        projectId,
        messages: [{ role: 'user', content: 'x' }],
      });
      const bad = await plantSession(db.sql, { projectId });
      await db.sql.unsafe(`UPDATE chat_sessions SET messages = '{"a":1}'::jsonb WHERE id = $1`, [
        bad.id,
      ]);

      await expect(runForward(db.sql)).rejects.toThrow(new RegExp(bad.id));

      const still = await db.sql.unsafe(`SELECT id FROM chat_sessions ORDER BY id`);
      expect(still.map((r) => r.id).sort()).toEqual([good.id, bad.id].sort());
      const tables = await db.sql.unsafe(
        `SELECT table_name FROM information_schema.tables WHERE table_name = 'conversations'`,
      );
      expect(tables).toHaveLength(0);
    } finally {
      await db.drop();
    }
  });

  // cm:guard the element is REFUSED, never filtered out: the copy selects the three roles it can hold,
  // so a fourth vanishes and the assertion, filtering both sides alike, agrees nothing was lost.
  it('aborts naming the session that holds a message role the new schema cannot represent', async () => {
    const db = await freshDb();
    try {
      const { projectId } = await plantProject(db.sql, 'forge-dev');
      const bad = await plantSession(db.sql, {
        projectId,
        messages: [
          { role: 'user', content: 'ok' },
          { role: 'tool', content: 'a tool result nobody modelled' },
        ],
      });

      await expect(runForward(db.sql)).rejects.toThrow(
        new RegExp(`${bad.id}.*tool|tool.*${bad.id}`, 's'),
      );
      const still = await db.sql.unsafe(`SELECT id FROM chat_sessions`);
      expect(still).toHaveLength(1);
    } finally {
      await db.drop();
    }
  });

  it('aborts naming the session whose stored message carries no role at all', async () => {
    const db = await freshDb();
    try {
      const { projectId } = await plantProject(db.sql, 'forge-dev');
      const bad = await plantSession(db.sql, { projectId, messages: [{ content: 'roleless' }] });
      await expect(runForward(db.sql)).rejects.toThrow(new RegExp(bad.id));
    } finally {
      await db.drop();
    }
  });

  it('aborts naming the session whose source is no conversation adapter', async () => {
    const db = await freshDb();
    try {
      const { projectId } = await plantProject(db.sql, 'forge-dev');
      const bad = await plantSession(db.sql, { projectId, source: 'sms' });

      await expect(runForward(db.sql)).rejects.toThrow(
        new RegExp(`${bad.id}.*sms|sms.*${bad.id}`, 's'),
      );
      const still = await db.sql.unsafe(`SELECT id FROM chat_sessions`);
      expect(still).toHaveLength(1);
    } finally {
      await db.drop();
    }
  });
});

describe('0239 forward — the assertion is the thing that says no', () => {
  /** The real statement list with the statement matching `marker` removed. */
  function without(marker: string): string[] {
    const kept = conversations.filter((s) => !s.includes(marker));
    if (kept.length === conversations.length) throw new Error(`no statement contains ${marker}`);
    return kept;
  }

  // cm:guard a plant that plants nothing runs the REAL migration and passes green: both mutators
  // below silently missed once 0239 qualified its relations, so an edit that changed nothing throws
  function edited(marker: string, edit: (stmt: string) => string[]): string[] {
    const hit = conversations.filter((s) => s.includes(marker));
    if (hit.length !== 1) throw new Error(`${hit.length} statements contain ${marker}, wanted 1`);
    const out = conversations.flatMap((s) => (s.includes(marker) ? edit(s) : [s]));
    if (out.join('\n') === conversations.join('\n'))
      throw new Error(`${marker} edit changed nothing`);
    return out;
  }

  it('aborts when the handle participant is never attached', async () => {
    const db = await freshDb();
    try {
      const { projectId } = await plantProject(db.sql, 'forge-dev');
      const session = await plantSession(db.sql, { projectId });
      await expect(runForward(db.sql, without("'handle', COALESCE"))).rejects.toThrow(
        new RegExp(`${session.id}.*handle|handle.*${session.id}`, 's'),
      );
      const still = await db.sql.unsafe(`SELECT id FROM chat_sessions`);
      expect(still).toHaveLength(1);
    } finally {
      await db.drop();
    }
  });

  it('aborts when the person a session recorded is never attached', async () => {
    const db = await freshDb();
    try {
      const { projectId, ownerId } = await plantProject(db.sql, 'forge-dev');
      const session = await plantSession(db.sql, { projectId, userId: ownerId });
      await expect(runForward(db.sql, without("'person', cs.user_id"))).rejects.toThrow(
        new RegExp(session.id),
      );
    } finally {
      await db.drop();
    }
  });

  it('aborts when the messages are never copied', async () => {
    const db = await freshDb();
    try {
      const { projectId } = await plantProject(db.sql, 'forge-dev');
      const session = await plantSession(db.sql, {
        projectId,
        messages: [{ role: 'user', content: 'x' }],
      });
      await expect(
        runForward(db.sql, without('INSERT INTO public.conversation_messages\n')),
      ).rejects.toThrow(new RegExp(session.id));
    } finally {
      await db.drop();
    }
  });

  it('aborts when a transcript is copied out of its original order', async () => {
    const db = await freshDb();
    try {
      const { projectId } = await plantProject(db.sql, 'forge-dev');
      const session = await plantSession(db.sql, {
        projectId,
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'second' },
        ],
      });
      // cm:why the same copy with the ordinal read backwards — the transcript survives, its order does not
      const reordered = edited('INSERT INTO public.conversation_messages\n', (s) => [
        s.replace('(t.ord - 1)::int,', '(jsonb_array_length(cs.messages) - t.ord)::int,'),
      ]);
      await expect(runForward(db.sql, reordered)).rejects.toThrow(new RegExp(session.id));
    } finally {
      await db.drop();
    }
  });

  it('aborts when a conversation holds a message no source element accounts for', async () => {
    const db = await freshDb();
    try {
      const { projectId } = await plantProject(db.sql, 'forge-dev');
      const session = await plantSession(db.sql, {
        projectId,
        messages: [{ role: 'user', content: 'first' }],
      });
      const smuggled = edited('INSERT INTO public.conversation_messages\n', (s) => [
        s,
        `INSERT INTO public.conversation_messages (conversation_id, seq, role, content)
         SELECT id, 99, 'user', 'never said' FROM public.chat_sessions`,
      ]);
      await expect(runForward(db.sql, smuggled)).rejects.toThrow(new RegExp(session.id));
    } finally {
      await db.drop();
    }
  });
});

describe('0239 forward — a temp relation of the same name is not the source', () => {
  // cm:guard drop either half of 0239's search_path defence — the pin or the `public.` — and this
  // goes red on the missing conversation, which is the migration orphaning every real transcript
  it('copies the real rows even when the deploying session carries a temp chat_sessions', async () => {
    const db = await freshDb();
    try {
      const { projectId, ownerId } = await plantProject(db.sql, 'forge-dev');
      const session = await plantSession(db.sql, {
        projectId,
        userId: ownerId,
        title: 'in the real table',
        source: 'rocketchat',
        messages: [{ role: 'user', content: 'only in public' }],
      });

      await runForward(db.sql, conversations, [
        `CREATE TEMP TABLE chat_sessions (
           id uuid, project_id uuid, user_id uuid, user_key text, title text,
           source text, messages jsonb, created_at timestamptz, updated_at timestamptz
         ) ON COMMIT DROP`,
      ]);

      const [c] = await db.sql.unsafe(`SELECT title FROM public.conversations WHERE id = $1`, [
        session.id,
      ]);
      expect(c?.title).toBe('in the real table');
      const [m] = await db.sql.unsafe(
        `SELECT content FROM public.conversation_messages WHERE conversation_id = $1`,
        [session.id],
      );
      expect(m?.content).toBe('only in public');

      // cm:guard the table the migration dropped is the real one, not the shadow it was handed
      const [left] = await db.sql.unsafe(
        `SELECT to_regclass('public.chat_sessions') AS still_there`,
      );
      expect(left?.still_there).toBeNull();
    } finally {
      await db.drop();
    }
  });
});
