/**
 * ISS-1001 — `0241_conversations.sql` forward, walked against a real Postgres
 * from the schema that existed BEFORE it.
 *
 * The omission cases are the point of the assertion block. Each one runs the
 * real statement list with ONE statement removed or corrupted and requires the
 * migration to abort naming the source session, before `chat_sessions` is
 * dropped. Without them, the assertion is a block that has never been observed
 * to say no.
 */

import { randomUUID } from 'node:crypto';
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

describe('0241 forward — what every legacy row becomes', () => {
  it('turns a chat session into one direct conversation carrying its messages in order', async () => {
    const db = await freshDb();
    try {
      const { projectId, ownerId } = await plantProject(db.sql, 'forge-dev');
      const session = await plantSession(db.sql, {
        projectId,
        userId: ownerId,
        title: 'a title',
        source: 'rocketchat',
        messages: [
          { role: 'user', content: 'first', ts: '2026-04-01T00:00:00.000Z' },
          { role: 'assistant', content: 'second', ts: '2026-04-01T00:00:01.000Z' },
        ],
      });

      await runForward(db.sql);

      const [c] = await db.sql.unsafe(`SELECT * FROM conversations WHERE id = $1`, [session.id]);
      expect(c).toMatchObject({
        adapter: 'rocketchat',
        external_id: `legacy:${session.id}`,
        shape: 'direct',
        title: 'a title',
      });

      const msgs = await db.sql.unsafe(
        `SELECT seq, role, content, author_user_id FROM conversation_messages
         WHERE conversation_id = $1 ORDER BY seq`,
        [session.id],
      );
      expect(msgs.map((m) => [m.seq, m.role, m.content])).toEqual([
        [0, 'user', 'first'],
        [1, 'assistant', 'second'],
      ]);
      expect(msgs[0]?.author_user_id).toBe(ownerId);
      expect(msgs[1]?.author_user_id).not.toBe(ownerId);
    } finally {
      await db.drop();
    }
  });

  it('leaves the conversation row with no project column to carry', async () => {
    const db = await freshDb();
    try {
      const { projectId } = await plantProject(db.sql, 'forge-dev');
      await plantSession(db.sql, { projectId });
      await runForward(db.sql);
      const columns = await db.sql.unsafe(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'conversations'`,
      );
      const names = columns.map((c) => (c as unknown as { column_name: string }).column_name);
      expect(names).not.toContain('project_id');
      expect(names.filter((n) => n.includes('project'))).toEqual([]);
    } finally {
      await db.drop();
    }
  });

  it('names the handle on an assistant turn, the person on a user turn, and nobody where nobody was', async () => {
    const db = await freshDb();
    try {
      const { projectId, ownerId } = await plantProject(db.sql, 'forge-dev');
      const named = await plantSession(db.sql, {
        projectId,
        userId: ownerId,
        messages: [
          { role: 'user', content: 'asked' },
          { role: 'assistant', content: 'answered' },
        ],
      });
      const anonymous = await plantSession(db.sql, {
        projectId,
        messages: [{ role: 'user', content: 'asked by nobody recorded' }],
      });

      await runForward(db.sql);

      const [handle] = await db.sql.unsafe(
        `SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND kind = 'handle'`,
        [named.id],
      );
      const handleId = (handle as unknown as { user_id: string }).user_id;

      const rows = await db.sql.unsafe(
        `SELECT seq, role, author_user_id FROM conversation_messages WHERE conversation_id = $1 ORDER BY seq`,
        [named.id],
      );
      expect(
        rows.map((r) => [
          (r as unknown as { role: string }).role,
          (r as unknown as { author_user_id: string | null }).author_user_id,
        ]),
      ).toEqual([
        ['user', ownerId],
        ['assistant', handleId],
      ]);

      const [orphan] = await db.sql.unsafe(
        `SELECT author_user_id, author_label FROM conversation_messages WHERE conversation_id = $1`,
        [anonymous.id],
      );
      expect(orphan).toMatchObject({ author_user_id: null, author_label: null });
    } finally {
      await db.drop();
    }
  });
});

describe('0241 forward — the handle each project gets', () => {
  it('gives the project a handle with its two memberships and NO access token', async () => {
    const db = await freshDb();
    try {
      const { orgId, projectId } = await plantProject(db.sql, 'forge-dev');
      await plantSession(db.sql, { projectId });
      await runForward(db.sql);

      const agents = await db.sql.unsafe(
        `SELECT u.id, u.email, u.password_hash FROM users u
         JOIN project_members pm ON pm.user_id = u.id AND pm.project_id = $1
         WHERE u.kind = 'agent'`,
        [projectId],
      );
      expect(agents).toHaveLength(1);
      const handle = agents[0] as unknown as {
        id: string;
        email: string;
        password_hash: string | null;
      };
      expect(handle.email).toMatch(/^forge-dev\.[0-9a-f]{12}@agents\.forge\.invalid$/);
      expect(handle.password_hash).toBeNull();

      const orgRows = await db.sql.unsafe(
        `SELECT 1 FROM organization_members WHERE user_id = $1 AND org_id = $2`,
        [handle.id, orgId],
      );
      expect(orgRows).toHaveLength(1);
      const tokens = await db.sql.unsafe(
        `SELECT 1 FROM personal_access_tokens WHERE user_id = $1`,
        [handle.id],
      );
      expect(tokens).toHaveLength(0);
    } finally {
      await db.drop();
    }
  });

  it('reuses the agent account a project already has instead of minting a second', async () => {
    const db = await freshDb();
    try {
      const { orgId, projectId } = await plantProject(db.sql, 'forge-dev');
      const existing = randomUUID();
      await db.sql.unsafe(
        `INSERT INTO users (id, email, kind, email_verified_at) VALUES ($1, $2, 'agent', now())`,
        [existing, `already.abcabcabcabc@agents.forge.invalid`],
      );
      await db.sql.unsafe(
        `INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'member')`,
        [orgId, existing],
      );
      await db.sql.unsafe(
        `INSERT INTO project_members (user_id, project_id, role) VALUES ($1, $2, 'member')`,
        [existing, projectId],
      );
      const session = await plantSession(db.sql, { projectId });

      await runForward(db.sql);

      const agents = await db.sql.unsafe(
        `SELECT u.id FROM users u
         JOIN project_members pm ON pm.user_id = u.id AND pm.project_id = $1
         WHERE u.kind = 'agent'`,
        [projectId],
      );
      expect(agents.map((a) => a.id)).toEqual([existing]);

      const [c] = await db.sql.unsafe(`SELECT origin FROM conversations WHERE id = $1`, [
        session.id,
      ]);
      const origin = (c as unknown as { origin: Record<string, unknown> }).origin;
      expect(origin.mintedHandleUserId).toBeNull();
    } finally {
      await db.drop();
    }
  });

  it('gives two projects whose slugs sanitize alike their own handle each', async () => {
    const db = await freshDb();
    try {
      const a = await plantProject(db.sql, 'Forge Dev');
      const b = await plantProject(db.sql, 'forge_dev');
      await plantSession(db.sql, { projectId: a.projectId });
      await plantSession(db.sql, { projectId: b.projectId });

      await runForward(db.sql);

      const rows = await db.sql.unsafe(
        `SELECT pm.project_id, u.id FROM users u
         JOIN project_members pm ON pm.user_id = u.id
         WHERE u.kind = 'agent' AND pm.project_id IN ($1, $2)`,
        [a.projectId, b.projectId],
      );
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.id)).size).toBe(2);
    } finally {
      await db.drop();
    }
  });
});

describe('0241 forward — the person a row did or did not record', () => {
  it('leaves a session that recorded nobody with its handle and no invented person', async () => {
    const db = await freshDb();
    try {
      const { projectId } = await plantProject(db.sql, 'forge-dev');
      const session = await plantSession(db.sql, {
        projectId,
        userId: null,
        userKey: null,
        messages: [{ role: 'user', content: 'anonymous' }],
      });

      await runForward(db.sql);

      const parts = await db.sql.unsafe(
        `SELECT kind, user_id, external_key FROM conversation_participants WHERE conversation_id = $1`,
        [session.id],
      );
      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({ kind: 'handle' });
    } finally {
      await db.drop();
    }
  });

  it('records the person a session named, by user or by key', async () => {
    const db = await freshDb();
    try {
      const { projectId, ownerId } = await plantProject(db.sql, 'forge-dev');
      const byUser = await plantSession(db.sql, { projectId, userId: ownerId });
      const byKey = await plantSession(db.sql, { projectId, userKey: 'widget:abc' });

      await runForward(db.sql);

      const [p1] = await db.sql.unsafe(
        `SELECT user_id, external_key FROM conversation_participants
         WHERE conversation_id = $1 AND kind = 'person'`,
        [byUser.id],
      );
      expect(p1).toMatchObject({ user_id: ownerId, external_key: null });
      const [p2] = await db.sql.unsafe(
        `SELECT user_id, external_key FROM conversation_participants
         WHERE conversation_id = $1 AND kind = 'person'`,
        [byKey.id],
      );
      expect(p2).toMatchObject({ user_id: null, external_key: 'widget:abc' });
    } finally {
      await db.drop();
    }
  });
});

describe('0241 forward — what it takes away', () => {
  it('drops the chat_sessions table and no chat row or field with it', async () => {
    const db = await freshDb();
    try {
      const { projectId, ownerId } = await plantProject(db.sql, 'forge-dev');
      const planted = [
        await plantSession(db.sql, {
          projectId,
          userId: ownerId,
          title: 'kept',
          source: 'rocketchat',
          messages: [{ role: 'user', content: 'one' }],
        }),
        await plantSession(db.sql, { projectId, userKey: 'widget:abc', messages: [] }),
        await plantSession(db.sql, {
          projectId,
          messages: [{ role: 'assistant', content: 'two' }],
        }),
      ];

      await runForward(db.sql);

      const gone = await db.sql.unsafe(
        `SELECT table_name FROM information_schema.tables WHERE table_name = 'chat_sessions'`,
      );
      expect(gone).toHaveLength(0);

      for (const row of planted) {
        const [c] = await db.sql.unsafe(
          `SELECT title, adapter, origin FROM conversations WHERE id = $1`,
          [row.id],
        );
        const seen = c as unknown as {
          title: string | null;
          adapter: string;
          origin: Record<string, unknown>;
        };
        expect(seen.title).toBe(row.title);
        expect(seen.adapter).toBe(row.source);
        expect(seen.origin).toMatchObject({
          chatSessionId: row.id,
          projectId: row.projectId,
          userId: row.userId,
          userKey: row.userKey,
          source: row.source,
        });
      }

      const kept = await db.sql.unsafe(`SELECT count(*)::int AS n FROM conversations`);
      expect((kept[0] as unknown as { n: number }).n).toBe(planted.length);
    } finally {
      await db.drop();
    }
  });
});
