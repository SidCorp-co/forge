/**
 * ISS-1389 — a project's stored test credential reaches no issue comment, by whichever path the
 * text comes in.
 *
 * A caller's write through REST or the `forge_comments` tool is refused by name with the position
 * of the value; text core writes itself, the run-ended comment among it, has the value replaced in
 * place by a marker. Real Postgres, because what is claimed is what is STORED, read back.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Caller,
  callRest,
  callTool,
  type Door,
  type Role,
  seedRoles,
} from '../helpers/door-parity.js';
import {
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';
import { bodiesOn as commentBodies, aRunOver as runOver } from '../helpers/run-evidence-fixture.js';

let harness: TestDatabase;
let server: TestServer;
let projectId: string;
let ownerId: string;
let callers: Record<Role, Caller>;
let mods: {
  writeRunEvidence: typeof import('../../src/devices/run-evidence.js').writeRunEvidence;
  openRunSession: typeof import('../../src/devices/run-session.js').openRunSession;
  insertSystemComment: typeof import('../../src/comments/system-write.js').insertSystemComment;
  insertComment: typeof import('../../src/comments/service.js').insertComment;
  logger: typeof import('../../src/logger.js').logger;
  postCapReachedComment: typeof import('../../src/pipeline/autonomous-rescue-comment.js').postCapReachedComment;
};

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  server = await startTestServer();
  const evidence = await import('../../src/devices/run-evidence.js');
  const runSession = await import('../../src/devices/run-session.js');
  mods = {
    writeRunEvidence: evidence.writeRunEvidence,
    openRunSession: runSession.openRunSession,
    insertSystemComment: (await import('../../src/comments/system-write.js')).insertSystemComment,
    insertComment: (await import('../../src/comments/service.js')).insertComment,
    logger: (await import('../../src/logger.js')).logger,
    postCapReachedComment: (await import('../../src/pipeline/autonomous-rescue-comment.js'))
      .postCapReachedComment,
  };
}, 180_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const seeded = await seedRoles(harness.db);
  projectId = seeded.projectId;
  ownerId = seeded.ownerId;
  callers = seeded.callers;
});

const USERNAME = 'qa-user@sidcorp.test';
const PASSWORD = 'Correct-Horse-9!';
const SHORT = 'viewer1';

async function storeCredentials(id: string): Promise<void> {
  const environments = {
    preview: null,
    live: { url: 'https://live.example.test' },
    testCredentials: [
      { label: 'staging admin', username: USERNAME, password: PASSWORD },
      { label: 'viewer', username: SHORT, password: 'v1' },
    ],
  };
  await harness.db.execute(
    sql`UPDATE projects SET environments = ${JSON.stringify(environments)}::jsonb WHERE id = ${id}`,
  );
}

let seq = 0;
async function issue(): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, 'open', ${ownerId})`);
  return id;
}

async function bodies(issueId: string): Promise<string[]> {
  return commentBodies(harness.db, issueId);
}

const A_CHECKPOINT = {
  source: 'reconstructed_from_box',
  branch: 'ISS-9-feature',
  head: 'aaaaaaaaaaaa',
  base: 'bbbbbbbbbbbb',
  filesTouched: ['src/one.ts'],
  commitsAhead: 2,
  commitsUnpushed: 1,
  workingTreeDirty: true,
  endedBy: 'master',
  endedReason: 'the run process is gone from this box',
  unread: [],
};

describe('the run-ended comment, where a master closed a run with a reason', () => {
  it('withholds a stored username from the ended reason row and keeps the rest of the row', async () => {
    const { device, project, issueIds, session } = await runOver(
      harness.db,
      mods.openRunSession,
      [9],
      'next: nothing',
    );
    await storeCredentials(project.id);

    await mods.writeRunEvidence({
      deviceId: device.id,
      sessionId: session.sessionId,
      checkpoint: { ...A_CHECKPOINT, endedReason: `closed after signing in as ${USERNAME}, done` },
    });

    const [body] = await bodies(issueIds[0] as string);
    expect(body).toBeDefined();
    const text = body as string;
    expect(text, 'the stored username must not be in the posted comment').not.toContain(USERNAME);
    expect(text).toContain('closed after signing in as [withheld: test credential "staging admin"');
    expect(text).toContain(', done');
    expect(text, 'every other row reads as it did').toContain('- branch: `ISS-9-feature`');
    expect(text).toContain('- ended by: `master`');
  });

  it('withholds a stored password the run wrote about itself, in any letter case', async () => {
    const { device, project, issueIds, session } = await runOver(
      harness.db,
      mods.openRunSession,
      [9],
      `next: log in with ${PASSWORD.toUpperCase()} then retry`,
    );
    await storeCredentials(project.id);

    await mods.writeRunEvidence({
      deviceId: device.id,
      sessionId: session.sessionId,
      checkpoint: A_CHECKPOINT,
    });

    const [text] = await bodies(issueIds[0] as string);
    expect(text?.toLowerCase()).not.toContain(PASSWORD.toLowerCase());
    expect(text).toContain('then retry');
  });

  it('leaves a short stored value inside a longer sentence as written', async () => {
    const { device, project, issueIds, session } = await runOver(
      harness.db,
      mods.openRunSession,
      [9],
      null,
    );
    await storeCredentials(project.id);

    await mods.writeRunEvidence({
      deviceId: device.id,
      sessionId: session.sessionId,
      checkpoint: { ...A_CHECKPOINT, endedReason: `the ${SHORT} account was never used` },
    });

    const [text] = await bodies(issueIds[0] as string);
    expect(text).toContain(`the ${SHORT} account was never used`);
    expect(text).not.toContain('[withheld');
  });

  it('is still written once where a stored credential sits in its own dedupe marker', async () => {
    const { device, project, issueIds, session } = await runOver(
      harness.db,
      mods.openRunSession,
      [9],
      null,
    );
    await harness.db.execute(
      sql`UPDATE projects SET environments = ${JSON.stringify({
        testCredentials: [{ label: 'odd', username: 'u', password: 'run-evidence:' }],
      })}::jsonb WHERE id = ${project.id}`,
    );
    const write = () =>
      mods.writeRunEvidence({
        deviceId: device.id,
        sessionId: session.sessionId,
        checkpoint: A_CHECKPOINT,
      });

    expect(await write()).toEqual({ issues: 1, written: 1 });
    expect(await write()).toEqual({ issues: 1, written: 0 });
    expect(await bodies(issueIds[0] as string)).toHaveLength(1);
  });

  it('writes a project that stores no credentials exactly as before', async () => {
    const { device, issueIds, session } = await runOver(harness.db, mods.openRunSession, [9], null);

    await mods.writeRunEvidence({
      deviceId: device.id,
      sessionId: session.sessionId,
      checkpoint: { ...A_CHECKPOINT, endedReason: `signed in as ${USERNAME}` },
    });

    const [text] = await bodies(issueIds[0] as string);
    expect(text).toContain(`signed in as ${USERNAME}`);
    expect(text).not.toContain('[withheld');
  });
});

/** The same stored values written so that only a reader, not a literal match on the body, sees them. */
const ENCODED: Array<[string, string]> = [
  ['a numeric character reference', 'log in as qa-user&#64;sidcorp.test'],
  ['a named character reference', 'the password is Correct-Horse-9&excl;'],
  ['empty tags splitting the value', 'log in as qa-user@sid<b></b>corp.test'],
  ['emphasis inside the value', 'log in as qa-user@sid**corp**.test'],
  ['a link wrapping part of the value', 'log in as [qa-user@sid](https://x.test)corp.test'],
  ['a backslash escape', 'log in as qa\\-user@sidcorp.test'],
];

type Write = (who: Caller, issueId: string, body: string) => Promise<Door>;

const creates: Record<string, Write> = {
  'REST POST /api/issues/:id/comments': (who, issueId, body) =>
    callRest(server.baseUrl, who.jwt, 'POST', `/api/issues/${issueId}/comments`, { body }),
  'forge_comments create': (who, issueId, body) =>
    callTool(who.pat, 'forge_comments', { action: 'create', data: { issue: issueId, body } }),
};

describe.each(Object.entries(creates))('a comment written through %s', (_name, create) => {
  it('is refused naming the position and where the value is read, and stores nothing', async () => {
    await storeCredentials(projectId);
    const here = await issue();

    const { refused } = await create(callers.member, here, `first line\nlog in as ${USERNAME}`);

    expect(refused, 'a stored test credential must be refused').toBeDefined();
    expect(refused).toContain('stored-test-credential');
    expect(refused).toContain('staging admin');
    expect(refused).toContain('line 2, column 11');
    expect(refused).toContain('environments.testCredentials');
    expect(refused, 'the refusal must not echo the value it refuses').not.toContain(USERNAME);
    expect(await bodies(here)).toEqual([]);
  });

  it.each(ENCODED)('is refused where the value is written with %s', async (_how, text) => {
    await storeCredentials(projectId);
    const here = await issue();
    const { refused } = await create(callers.member, here, text);
    expect(refused, 'what a reader sees as a credential must be refused').toContain(
      'stored-test-credential',
    );
    expect(refused).toContain('the text the comment reads as');
    expect(await bodies(here)).toEqual([]);
  });

  it('is refused for a password in another letter case', async () => {
    await storeCredentials(projectId);
    const here = await issue();
    const { refused } = await create(callers.member, here, `pw ${PASSWORD.toLowerCase()}`);
    expect(refused).toBeDefined();
    expect(await bodies(here)).toEqual([]);
  });

  it('stores a body that carries no credential byte for byte', async () => {
    await storeCredentials(projectId);
    const here = await issue();
    const plain = `the ${SHORT} account, a v1 release,\nand a second line `;
    expect(await create(callers.member, here, plain)).not.toHaveProperty('refused');
    expect(await bodies(here)).toEqual([plain]);
  });

  it('is accepted by a project that stores no credentials', async () => {
    const here = await issue();
    const text = `signed in as ${USERNAME}`;
    expect(await create(callers.member, here, text)).not.toHaveProperty('refused');
    expect(await bodies(here)).toEqual([text]);
  });
});

async function aComment(issueId: string, authorId: string, body: string): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO comments (id, issue_id, author_id, body) VALUES (${id}, ${issueId}, ${authorId}, ${body})`);
  return id;
}

type Edit = (who: Caller, commentId: string, body: string) => Promise<Door>;

const edits: Record<string, Edit> = {
  'REST PATCH /api/comments/:id': (who, id, body) =>
    callRest(server.baseUrl, who.jwt, 'PATCH', `/api/comments/${id}`, { body }),
  'forge_comments update': (who, id, body) =>
    callTool(who.pat, 'forge_comments', { action: 'update', documentId: id, data: { body } }),
};

describe.each(Object.entries(edits))('an edit through %s', (_name, edit) => {
  it('is refused when the new body carries a stored credential, and the old words stay', async () => {
    await storeCredentials(projectId);
    const id = await aComment(await issue(), callers.member.userId, 'the first words');

    const { refused } = await edit(callers.member, id, `now with ${PASSWORD}`);

    expect(refused).toContain('stored-test-credential');
    expect(refused).not.toContain(PASSWORD);
    const rows = (await harness.db.execute(
      sql`SELECT body FROM comments WHERE id = ${id}`,
    )) as unknown as Array<{ body: string }>;
    expect(rows[0]?.body).toBe('the first words');
  });

  it.each(ENCODED)('is refused where the new body writes the value with %s', async (_how, text) => {
    await storeCredentials(projectId);
    const id = await aComment(await issue(), callers.member.userId, 'the first words');
    const { refused } = await edit(callers.member, id, text);
    expect(refused).toContain('stored-test-credential');
    const rows = (await harness.db.execute(
      sql`SELECT body FROM comments WHERE id = ${id}`,
    )) as unknown as Array<{ body: string }>;
    expect(rows[0]?.body).toBe('the first words');
  });

  it('admits a body that carries none', async () => {
    await storeCredentials(projectId);
    const id = await aComment(await issue(), callers.member.userId, 'the first words');
    expect(await edit(callers.member, id, 'rewritten')).not.toHaveProperty('refused');
  });
});

describe('a comment written as HTML', () => {
  const HTML_PASSWORD = 'Tom&Jerry-Secret-12';

  async function storeHtmlPassword(): Promise<void> {
    await harness.db.execute(
      sql`UPDATE projects SET environments = ${JSON.stringify({
        testCredentials: [{ label: 'html', username: 'u', password: HTML_PASSWORD }],
      })}::jsonb WHERE id = ${projectId}`,
    );
  }

  it.each([
    ['entity-encoded', '<p>Tom&amp;Jerry-Secret-12</p>'],
    ['literal', '<p>Tom&Jerry-Secret-12</p>'],
    ['attribute', '<p><img src="/a.png" alt="Tom&amp;Jerry-Secret-12"></p>'],
  ])('is refused when the %s password is in it, and stores nothing', async (_how, html) => {
    await storeHtmlPassword();
    const here = await issue();
    const { refused } = await callRest(
      server.baseUrl,
      callers.member.jwt,
      'POST',
      `/api/issues/${here}/comments`,
      { body: html, format: 'html' },
    );
    expect(refused).toContain('stored-test-credential');
    expect(await bodies(here)).toEqual([]);
  });
});

describe('a report core repeats about an issue', () => {
  it('is posted once where a stored credential sits in its own words', async () => {
    await harness.db.execute(
      sql`UPDATE projects SET environments = ${JSON.stringify({
        testCredentials: [{ label: 'odd', username: 'u', password: 'awaiting_release' }],
      })}::jsonb WHERE id = ${projectId}`,
    );
    const here = await issue();
    const args = {
      issueId: here,
      authorId: ownerId,
      fromStatus: 'awaiting_release' as const,
      cap: 3,
      driveSessions: 3,
    };

    await mods.postCapReachedComment(args);
    await mods.postCapReachedComment(args);

    const stored = await bodies(here);
    expect(stored).toHaveLength(1);
    expect(stored[0]).not.toContain('awaiting_release');
    expect(stored[0]).toContain('[withheld');
  });
});

describe('text core writes itself onto an issue', () => {
  it('replaces a stored credential in place, keeps the surrounding text, and logs the label', async () => {
    await storeCredentials(projectId);
    const here = await issue();
    const warn = vi.spyOn(mods.logger, 'warn');

    await mods.insertSystemComment({
      issueId: here,
      authorId: ownerId,
      body: `held: signed in with ${USERNAME} and ${PASSWORD}, then stopped`,
    });

    const [text] = await bodies(here);
    expect(text).not.toContain(USERNAME);
    expect(text).not.toContain(PASSWORD);
    expect(text).toMatch(
      /^held: signed in with \[withheld: .+\] and \[withheld: .+\], then stopped$/,
    );
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain(here);
    expect(logged).toContain('staging admin');
    expect(logged, 'the log names the label and never the value').not.toContain(USERNAME);
    expect(logged).not.toContain(PASSWORD);
    warn.mockRestore();
  });

  it('withholds from a writer that goes through insertComment and passes withhold, never refusing it', async () => {
    await storeCredentials(projectId);
    const here = await issue();

    const written = await mods.insertComment({
      issueId: here,
      authorId: ownerId,
      authorDeviceId: null,
      body: `mirrored: ${USERNAME}`,
      parentId: null,
      credentials: 'withhold',
    });

    expect(written.row.body).not.toContain(USERNAME);
    expect(written.row.body).toContain('mirrored: [withheld: test credential "staging admin"');
    expect(written.warnings.join(' ')).toContain('staging admin');
    expect(await bodies(here)).toEqual([written.row.body]);
  });

  it('stores a text that carries none untouched, and withholding twice changes nothing', async () => {
    await storeCredentials(projectId);
    const here = await issue();
    const plain = 'a plain note about the viewer1 account';
    await mods.insertSystemComment({ issueId: here, authorId: ownerId, body: plain });
    const once = (await mods.insertSystemComment({
      issueId: here,
      authorId: ownerId,
      body: `as ${USERNAME}`,
    })) as { body: string };
    await mods.insertSystemComment({ issueId: here, authorId: ownerId, body: once.body });

    const stored = await bodies(here);
    expect(stored[0]).toBe(plain);
    expect(stored[2]).toBe(once.body);
  });
});
