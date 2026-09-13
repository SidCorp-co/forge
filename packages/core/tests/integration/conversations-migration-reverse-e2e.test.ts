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

describe('0238 reverse — the forward drop is a relocation', () => {
  const rollback = readFileSync(ROLLBACK, 'utf8');

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

  it('keeps a minted handle that has since been given an access token', async () => {
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

      await db.sql.unsafe(rollback);

      const survivors = await db.sql.unsafe(`SELECT id FROM users WHERE id = $1`, [handleId]);
      expect(survivors).toHaveLength(1);
    } finally {
      await db.drop();
    }
  });
});
