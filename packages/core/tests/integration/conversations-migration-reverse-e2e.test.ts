/**
 * ISS-1001 — the reverse of `0241_conversations.sql`, which is what makes the
 * forward drop a relocation rather than a discard.
 *
 * Drizzle has no down migrations, so the reverse is a checked-in file run by
 * hand. A file nobody executes is a description; this is what executes it.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
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

const ROLLBACK = fileURLToPath(
  new URL('../../drizzle/rollback/0241_conversations_down.sql', import.meta.url),
);

const rollback = readFileSync(ROLLBACK, 'utf8');

describe('0241 reverse — the forward drop is a relocation', () => {
  it('rebuilds a consumed row exactly, from `origin` and not from a membership', async () => {
    const db = await freshDb();
    try {
      const { projectId, ownerId } = await plantProject(db.sql, 'forge-dev');
      const session = await plantSession(db.sql, {
        projectId,
        userId: ownerId,
        userKey: null,
        title: 'a title',
        source: 'rocketchat',
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'second' },
        ],
      });
      const [beforeRow] = await db.sql.unsafe(
        `SELECT id, project_id, user_id, user_key, title, source, created_at, updated_at
         FROM chat_sessions WHERE id = $1`,
        [session.id],
      );

      await runForward(db.sql);

      // cm:guard the handle's membership MOVES before the rollback, because the reconstruction must
      // come off `origin` alone; consult a membership here and this assertion stops proving that.
      const other = await plantProject(db.sql, 'somewhere-else');
      await db.sql.unsafe(
        `UPDATE project_members SET project_id = $1
         WHERE user_id = (SELECT user_id FROM conversation_participants
                          WHERE conversation_id = $2 AND kind = 'handle')`,
        [other.projectId, session.id],
      );

      await db.sql.unsafe(rollback);

      const [afterRow] = await db.sql.unsafe(
        `SELECT id, project_id, user_id, user_key, title, source, created_at, updated_at
         FROM chat_sessions WHERE id = $1`,
        [session.id],
      );
      expect(afterRow).toEqual(beforeRow);

      const [restored] = await db.sql.unsafe(`SELECT messages FROM chat_sessions WHERE id = $1`, [
        session.id,
      ]);
      const messages = (restored as unknown as { messages: Array<Record<string, unknown>> })
        .messages;
      expect(messages.map((m) => [m.role, m.content])).toEqual([
        ['user', 'first'],
        ['assistant', 'second'],
      ]);
    } finally {
      await db.drop();
    }
  });

  // cm:guard byte equality on the BLOB, not equivalence: an element with no `ts`, or a key the schema
  // models nothing for, is what a rebuild from the rows re-synthesizes — the reverse reads `origin`.
  it('rebuilds the stored transcript exactly, keys the new schema models and keys it does not', async () => {
    const db = await freshDb();
    try {
      const { projectId, ownerId } = await plantProject(db.sql, 'forge-dev');
      const blob = [
        { role: 'user', content: 'no timestamp on this one' },
        {
          role: 'assistant',
          content: 'and this one carries a key nothing reads',
          ts: '2026-04-01T00:00:01.000Z',
          citations: [{ issue: 'ISS-1' }],
        },
      ];
      const session = await plantSession(db.sql, { projectId, userId: ownerId, messages: blob });

      await runForward(db.sql);
      await db.sql.unsafe(rollback);

      const [row] = await db.sql.unsafe(`SELECT messages FROM chat_sessions WHERE id = $1`, [
        session.id,
      ]);
      expect((row as unknown as { messages: unknown }).messages).toEqual(blob);
    } finally {
      await db.drop();
    }
  });

  it('rebuilds a conversation opened AFTER the forward run rather than dropping it', async () => {
    const db = await freshDb();
    try {
      const { projectId } = await plantProject(db.sql, 'forge-dev');
      await plantSession(db.sql, { projectId });
      await runForward(db.sql);

      const [handle] = await db.sql.unsafe(
        `SELECT u.id FROM users u JOIN project_members pm ON pm.user_id = u.id
         WHERE u.kind = 'agent' AND pm.project_id = $1`,
        [projectId],
      );
      const opened = randomUUID();
      await db.sql.unsafe(
        `INSERT INTO conversations (id, adapter, external_id, shape, title)
         VALUES ($1, 'rocketchat', 'chat.example.co ROOM9', 'group', 'since the deploy')`,
        [opened],
      );
      await db.sql.unsafe(
        `INSERT INTO conversation_participants (conversation_id, kind, user_id) VALUES ($1, 'handle', $2)`,
        [opened, (handle as unknown as { id: string }).id],
      );
      await db.sql.unsafe(
        `INSERT INTO conversation_messages (conversation_id, seq, role, content)
         VALUES ($1, 0, 'user', 'spoken after the deploy')`,
        [opened],
      );

      await db.sql.unsafe(rollback);

      const [row] = await db.sql.unsafe(
        `SELECT project_id, title, source, messages FROM chat_sessions WHERE id = $1`,
        [opened],
      );
      expect(row).toMatchObject({
        project_id: projectId,
        title: 'since the deploy',
        source: 'rocketchat',
      });
      expect(
        (row as unknown as { messages: Array<{ content: string }> }).messages[0]?.content,
      ).toBe('spoken after the deploy');
    } finally {
      await db.drop();
    }
  });

  it('deletes the handle it minted and leaves the one it reused standing', async () => {
    const db = await freshDb();
    try {
      const minted = await plantProject(db.sql, 'minted-here');
      const reused = await plantProject(db.sql, 'reused-here');
      const existing = randomUUID();
      await db.sql.unsafe(
        `INSERT INTO users (id, email, kind, email_verified_at) VALUES ($1, $2, 'agent', now())`,
        [existing, 'already.abcabcabcabc@agents.forge.invalid'],
      );
      await db.sql.unsafe(
        `INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'member')`,
        [reused.orgId, existing],
      );
      await db.sql.unsafe(
        `INSERT INTO project_members (user_id, project_id, role) VALUES ($1, $2, 'member')`,
        [existing, reused.projectId],
      );
      await plantSession(db.sql, { projectId: minted.projectId });
      await plantSession(db.sql, { projectId: reused.projectId });

      await runForward(db.sql);
      const [mintedHandle] = await db.sql.unsafe(
        `SELECT u.id FROM users u JOIN project_members pm ON pm.user_id = u.id
         WHERE u.kind = 'agent' AND pm.project_id = $1`,
        [minted.projectId],
      );

      await db.sql.unsafe(rollback);

      const survivors = await db.sql.unsafe(`SELECT id FROM users WHERE kind = 'agent'`);
      expect(survivors.map((s) => s.id)).toEqual([existing]);
      expect((mintedHandle as unknown as { id: string }).id).not.toBe(existing);
    } finally {
      await db.drop();
    }
  });
});

describe('0241 reverse — the principals it minted, and the ones it must not take', () => {
  // cm:guard the reverse REFUSES rather than choosing for whoever minted the token: deleting takes a
  // live credential, keeping reports a clean reverse that left a principal standing (criterion 41)
  it('refuses by name when a minted handle has since been given an access token', async () => {
    const db = await freshDb();
    try {
      const { projectId } = await plantProject(db.sql, 'forge-dev');
      await plantSession(db.sql, { projectId });
      await runForward(db.sql);
      const [handle] = await db.sql.unsafe(
        `SELECT u.id FROM users u JOIN project_members pm ON pm.user_id = u.id
         WHERE u.kind = 'agent' AND pm.project_id = $1`,
        [projectId],
      );
      const handleId = (handle as unknown as { id: string }).id;
      await db.sql.unsafe(
        `INSERT INTO personal_access_tokens (user_id, name, token_hash, token_prefix)
         VALUES ($1, 'given since', $2, 'forge_pat_given')`,
        [handleId, `hash-${randomUUID()}`],
      );

      await expect(db.sql.unsafe(rollback)).rejects.toThrow(new RegExp(handleId));
      // cm:why the refusal aborts the transaction the FILE opened, so this connection has to end it
      // before it can be read from — which is the whole point: nothing the reverse did is committed
      await db.sql.unsafe('ROLLBACK');

      // cm:guard it stopped BEFORE changing anything: the account stands, and so does the schema
      const survivors = await db.sql.unsafe(`SELECT id FROM users WHERE id = $1`, [handleId]);
      expect(survivors).toHaveLength(1);
      const [still] = await db.sql.unsafe(
        `SELECT to_regclass('public.conversations') AS c, to_regclass('public.chat_sessions') AS s`,
      );
      expect(still).toMatchObject({ c: 'conversations', s: null });
    } finally {
      await db.drop();
    }
  });

  // cm:guard compared in SQL and never through a JS `Date`, which truncates to milliseconds and
  // would report this green whatever the migration stored (ISS-1001)
  it('restores a timestamp to the microsecond it was stored with', async () => {
    const db = await freshDb();
    try {
      const { projectId } = await plantProject(db.sql, 'forge-dev');
      const session = await plantSession(db.sql, { projectId });
      // cm:guard planted as SQL literals and NOT bound parameters: the driver turns a bound
      // timestamp into a JS Date, so a parameterised plant arrives already truncated
      await db.sql.unsafe(
        `UPDATE chat_sessions
            SET created_at = '2026-04-01T10:11:12.123456Z'::timestamptz,
                updated_at = '2026-04-02T13:14:15.654321Z'::timestamptz
          WHERE id = $1`,
        [session.id],
      );
      const [planted] = await db.sql.unsafe(
        `SELECT created_at = '2026-04-01T10:11:12.123456Z'::timestamptz AS exact
           FROM chat_sessions WHERE id = $1`,
        [session.id],
      );
      expect(planted).toMatchObject({ exact: true });

      await runForward(db.sql);
      await db.sql.unsafe(rollback);

      const [same] = await db.sql.unsafe(
        `SELECT created_at = '2026-04-01T10:11:12.123456Z'::timestamptz AS created_exact,
                updated_at = '2026-04-02T13:14:15.654321Z'::timestamptz AS updated_exact
         FROM chat_sessions WHERE id = $1`,
        [session.id],
      );
      expect(same).toMatchObject({ created_exact: true, updated_exact: true });
    } finally {
      await db.drop();
    }
  });

  // cm:guard a room migrated and still talking: half two takes `origin IS NULL` only, so without
  // half one appending the later rows those turns come back missing and the row looks complete
  it('brings back what a migrated room said AFTER the forward run, not only what it was consumed with', async () => {
    const db = await freshDb();
    try {
      const { projectId, ownerId } = await plantProject(db.sql, 'forge-dev');
      const session = await plantSession(db.sql, {
        projectId,
        userId: ownerId,
        messages: [
          { role: 'user', content: 'said before the deploy', ts: '2026-04-01T00:00:00.1Z' },
        ],
      });

      await runForward(db.sql);

      // cm:why the room goes on talking, which is what appendMessage does to a live conversation
      await db.sql.unsafe(
        `INSERT INTO conversation_messages (conversation_id, seq, role, content, created_at)
         VALUES ($1, 1, 'user', 'said after the deploy', '2026-05-01T00:00:00Z'),
                ($1, 2, 'assistant', 'answered after the deploy', '2026-05-01T00:00:01Z')`,
        [session.id],
      );
      await db.sql.unsafe(`UPDATE conversations SET updated_at = $2 WHERE id = $1`, [
        session.id,
        '2026-05-01T00:00:01Z',
      ]);

      await db.sql.unsafe(rollback);

      const [back] = await db.sql.unsafe(
        `SELECT messages, updated_at FROM chat_sessions WHERE id = $1`,
        [session.id],
      );
      const msgs = (back as unknown as { messages: Array<Record<string, unknown>> }).messages;
      expect(msgs.map((m) => m.content)).toEqual([
        'said before the deploy',
        'said after the deploy',
        'answered after the deploy',
      ]);
      // cm:guard the consumed element comes back VERBATIM — its own `ts`, not a re-synthesized one
      expect(msgs[0]).toEqual({
        role: 'user',
        content: 'said before the deploy',
        ts: '2026-04-01T00:00:00.1Z',
      });
      expect(new Date((back as unknown as { updated_at: Date }).updated_at).toISOString()).toBe(
        '2026-05-01T00:00:01.000Z',
      );
    } finally {
      await db.drop();
    }
  });
});

describe('0241 reverse — the two fields the blob does not carry back by itself', () => {
  // cm:guard `origin` carries EVERY consumed field, title included, while the reverse restores the current title so a rename after the deploy survives exactly as the messages appended after it do.
  // cm:why a claim that every consumed field is reconstructible from `origin` alone is true by accident when the only copy of one lives in the column being read (ISS-1001).
  it('keeps the consumed title in `origin` and still restores a rename made after the deploy', async () => {
    const db = await freshDb();
    try {
      const { projectId, ownerId } = await plantProject(db.sql, 'forge-dev');
      const session = await plantSession(db.sql, {
        projectId,
        userId: ownerId,
        title: 'the title it was consumed with',
        messages: [{ role: 'user', content: 'hello' }],
      });

      await runForward(db.sql);

      const [origin] = await db.sql.unsafe(`SELECT origin FROM conversations WHERE id = $1`, [
        session.id,
      ]);
      expect((origin as unknown as { origin: { title: string } }).origin.title).toBe(
        'the title it was consumed with',
      );

      await db.sql.unsafe(`UPDATE conversations SET title = $2 WHERE id = $1`, [
        session.id,
        'renamed after the deploy',
      ]);
      await db.sql.unsafe(rollback);

      const [back] = await db.sql.unsafe(`SELECT title FROM chat_sessions WHERE id = $1`, [
        session.id,
      ]);
      expect((back as unknown as { title: string }).title).toBe('renamed after the deploy');
    } finally {
      await db.drop();
    }
  });

  // cm:guard a silence is neither dropped nor smuggled back into the replayed blob: the reverted code replays `messages` to the provider verbatim and never wrote an element with empty text, so an empty assistant element is a prompt shape it has never produced.
  // cm:why losing the row outright would delete the one field the new model exists to keep, which is why it is archived rather than filtered away (ISS-1001).
  it('archives a silence instead of discarding it or replaying it as an empty answer', async () => {
    const db = await freshDb();
    try {
      const { projectId, ownerId } = await plantProject(db.sql, 'forge-dev');
      const session = await plantSession(db.sql, {
        projectId,
        userId: ownerId,
        messages: [{ role: 'user', content: 'said before the deploy' }],
      });

      await runForward(db.sql);

      await db.sql.unsafe(
        `INSERT INTO conversation_messages (conversation_id, seq, role, content, created_at)
         VALUES ($1, 1, 'user', 'asked after the deploy', '2026-05-01T00:00:00Z')`,
        [session.id],
      );
      await db.sql.unsafe(
        `INSERT INTO conversation_messages
           (conversation_id, seq, role, content, silence_reason, created_at)
         VALUES ($1, 2, 'assistant', '', 'the provider timed out', '2026-05-01T00:00:01Z')`,
        [session.id],
      );

      // cm:guard the archive is keyed by the MESSAGE id: a `(session, seq)` key would name a different message on a second forward-and-back cycle, and `DO NOTHING` would then drop the new silence.
      const [silenceRow] = await db.sql.unsafe(
        `SELECT id FROM conversation_messages WHERE conversation_id = $1 AND seq = 2`,
        [session.id],
      );
      const messageId = (silenceRow as unknown as { id: string }).id;

      await db.sql.unsafe(rollback);

      const [back] = await db.sql.unsafe(`SELECT messages FROM chat_sessions WHERE id = $1`, [
        session.id,
      ]);
      const msgs = (back as unknown as { messages: Array<Record<string, unknown>> }).messages;
      expect(msgs.map((m) => m.content)).toEqual([
        'said before the deploy',
        'asked after the deploy',
      ]);

      const archived = await db.sql.unsafe(
        `SELECT message_id, session_id, seq, reason FROM chat_session_silences WHERE session_id = $1`,
        [session.id],
      );
      expect(archived).toEqual([
        {
          message_id: messageId,
          session_id: session.id,
          seq: 2,
          reason: 'the provider timed out',
        },
      ]);
    } finally {
      await db.drop();
    }
  });
});
