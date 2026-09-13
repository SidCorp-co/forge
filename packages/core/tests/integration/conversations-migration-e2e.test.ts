/**
 * ISS-1001 — `0239_conversations.sql` and its reverse, walked against a real
 * Postgres from the schema that existed BEFORE it.
 *
 * The harness's own database already has the migration applied and no
 * `chat_sessions` to migrate, so this suite builds its own: every migration
 * below 0238 into a template database once, then a clone per case with the
 * rows that case is about. That is the only way to plant the row the migration
 * must refuse — after the forward run there is nothing left to plant into.
 *
 * The omission cases are the point of the assertion block. Each one runs the
 * real statement list with ONE statement removed or corrupted and requires the
 * migration to abort naming the source session, before `chat_sessions` is
 * dropped. Without them, the assertion is a block that has never been observed
 * to say no.
 */

import { randomUUID } from 'node:crypto';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle/migrations', import.meta.url));
const ROLLBACK = fileURLToPath(
  new URL('../../drizzle/rollback/0239_conversations_down.sql', import.meta.url),
);

/** The statement list of 0238, and everything below it, split at the same seam drizzle splits. */
function migrationParts(): { below: string[]; conversations: string[] } {
  const files = readMigrationFiles({ migrationsFolder: MIGRATIONS });
  const target = files.find((f) => f.sql.join('\n').includes('_iss1001_handles'));
  if (!target) throw new Error('0239_conversations.sql is not in the migrations folder');
  const below = files
    .filter((f) => f.folderMillis < target.folderMillis)
    .sort((a, b) => a.folderMillis - b.folderMillis)
    .flatMap((f) => f.sql);
  return { below, conversations: target.sql };
}

const { below, conversations } = migrationParts();

let adminUrl: string;
let admin: Sql;
let template: string;

/** A database at the schema 0238 expects to find, cloned rather than replayed. */
async function freshDb(): Promise<{ sql: Sql; drop: () => Promise<void> }> {
  const name = `iss1001_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  await admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
  return {
    sql,
    drop: async () => {
      await sql.end({ timeout: 5 }).catch(() => {});
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    },
  };
}

/** Run the forward migration as drizzle runs it: every statement, one transaction. */
async function runForward(sql: Sql, statements: string[] = conversations): Promise<void> {
  await sql.begin(async (tx) => {
    for (const stmt of statements) await tx.unsafe(stmt, []);
  });
}

interface PlantedSession {
  id: string;
  projectId: string;
  userId: string | null;
  userKey: string | null;
  title: string | null;
  source: string;
  messages: unknown;
}

/** An org, a project and a person — the ground a chat session sits on. */
async function plantProject(sql: Sql, slug: string): Promise<{ orgId: string; projectId: string; ownerId: string }> {
  const ownerId = randomUUID();
  const orgId = randomUUID();
  const projectId = randomUUID();
  await sql.unsafe(
    `INSERT INTO users (id, email, kind, email_verified_at) VALUES ($1, $2, 'human', now())`,
    [ownerId, `owner-${ownerId.slice(0, 8)}@example.com`],
  );
  await sql.unsafe(`INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)`, [
    orgId,
    `org ${slug}`,
    `org-${orgId.slice(0, 8)}`,
  ]);
  await sql.unsafe(
    `INSERT INTO projects (id, slug, name, created_by, org_id) VALUES ($1, $2, $3, $4, $5)`,
    [projectId, slug, slug, ownerId, orgId],
  );
  await sql.unsafe(
    `INSERT INTO project_members (user_id, project_id, role) VALUES ($1, $2, 'owner')`,
    [ownerId, projectId],
  );
  return { orgId, projectId, ownerId };
}

async function plantSession(sql: Sql, row: Partial<PlantedSession> & { projectId: string }): Promise<PlantedSession> {
  const planted: PlantedSession = {
    id: row.id ?? randomUUID(),
    projectId: row.projectId,
    userId: row.userId ?? null,
    userKey: row.userKey ?? null,
    title: row.title ?? null,
    source: row.source ?? 'web',
    messages: row.messages ?? [],
  };
  await sql.unsafe(
    `INSERT INTO chat_sessions (id, project_id, user_id, user_key, title, source, messages)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      planted.id,
      planted.projectId,
      planted.userId,
      planted.userKey,
      planted.title,
      planted.source,
      JSON.stringify(planted.messages),
    ],
  );
  return planted;
}

beforeAll(async () => {
  adminUrl = process.env.TEST_PG_ADMIN_URL ?? process.env.TEST_DATABASE_URL ?? '';
  if (!adminUrl) throw new Error('no TEST_PG_ADMIN_URL — global setup did not run');
  admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  template = `iss1001_tpl_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await admin.unsafe(`CREATE DATABASE "${template}"`);
  const url = new URL(adminUrl);
  url.pathname = `/${template}`;
  const tpl = postgres(url.toString(), { max: 1, onnotice: () => {} });
  try {
    await tpl.begin(async (tx) => {
      for (const stmt of below) await tx.unsafe(stmt, []);
    });
  } finally {
    await tpl.end({ timeout: 5 });
  }
}, 300_000);

afterAll(async () => {
  if (admin) {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${template}" WITH (FORCE)`).catch(() => {});
    await admin.end({ timeout: 5 });
  }
});

describe('0238 forward — what every legacy row becomes', () => {
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
      const handle = agents[0] as { id: string; email: string; password_hash: string | null };
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

      const [c] = await db.sql.unsafe(`SELECT origin FROM conversations WHERE id = $1`, [session.id]);
      const origin = (c as { origin: Record<string, unknown> }).origin;
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

  // cm:guard this is the correction of the issue's own filing, held as a test: ISS-1001's body says every legacy row becomes "a direct conversation with one person and one handle", and 34 of the 35 live rows record no person at all. The landed rule is one handle and AT MOST one person; a change that starts inventing a stand-in person reds here.
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

describe('0238 forward — a row it cannot represent stops the deploy', () => {
  it('aborts naming the session whose messages are not an array, and keeps the table', async () => {
    const db = await freshDb();
    try {
      const { projectId } = await plantProject(db.sql, 'forge-dev');
      const good = await plantSession(db.sql, { projectId, messages: [{ role: 'user', content: 'x' }] });
      const bad = await plantSession(db.sql, { projectId });
      await db.sql.unsafe(`UPDATE chat_sessions SET messages = '{"a":1}'::jsonb WHERE id = $1`, [bad.id]);

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

  it('aborts naming the session whose source is no conversation adapter', async () => {
    const db = await freshDb();
    try {
      const { projectId } = await plantProject(db.sql, 'forge-dev');
      const bad = await plantSession(db.sql, { projectId, source: 'sms' });

      await expect(runForward(db.sql)).rejects.toThrow(new RegExp(`${bad.id}.*sms|sms.*${bad.id}`, 's'));
      const still = await db.sql.unsafe(`SELECT id FROM chat_sessions`);
      expect(still).toHaveLength(1);
    } finally {
      await db.drop();
    }
  });
});

describe('0238 forward — the assertion is the thing that says no', () => {
  /** The real statement list with the statement matching `marker` removed. */
  function without(marker: string): string[] {
    const kept = conversations.filter((s) => !s.includes(marker));
    if (kept.length === conversations.length) throw new Error(`no statement contains ${marker}`);
    return kept;
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
      await expect(runForward(db.sql, without('WITH ORDINALITY AS t(step, ord)\n'))).rejects.toThrow(
        new RegExp(session.id),
      );
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
      const reordered = conversations.map((s) =>
        s.includes('WITH ORDINALITY AS t(step, ord)\n')
          ? s.replace('(t.ord - 1)::int,', '(jsonb_array_length(cs.messages) - t.ord)::int,')
          : s,
      );
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
      const smuggled = conversations.flatMap((s) =>
        s.includes('WITH ORDINALITY AS t(step, ord)\n')
          ? [
              s,
              `INSERT INTO conversation_messages (conversation_id, seq, role, content)
               SELECT id, 99, 'user', 'never said' FROM chat_sessions`,
            ]
          : [s],
      );
      await expect(runForward(db.sql, smuggled)).rejects.toThrow(new RegExp(session.id));
    } finally {
      await db.drop();
    }
  });
});

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
      const messages = (restored as { messages: Array<Record<string, unknown>> }).messages;
      expect(messages.map((m) => [m.role, m.content])).toEqual([
        ['user', 'first'],
        ['assistant', 'second'],
      ]);
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
        [opened, (handle as { id: string }).id],
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
      expect(row).toMatchObject({ project_id: projectId, title: 'since the deploy', source: 'rocketchat' });
      expect((row as { messages: Array<{ content: string }> }).messages[0]?.content).toBe(
        'spoken after the deploy',
      );
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
      expect((mintedHandle as { id: string }).id).not.toBe(existing);
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
      const handleId = (handle as { id: string }).id;
      await db.sql.unsafe(
        `INSERT INTO personal_access_tokens (user_id, name, token_hash, scopes)
         VALUES ($1, 'given since', $2, '{}')`,
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
