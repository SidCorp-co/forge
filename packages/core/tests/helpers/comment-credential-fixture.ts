/**
 * What the comment-credential suites share: a project's stored test credentials, an issue and a
 * comment to write against, and the four doors a caller writes a comment through.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { TestDb } from './db.js';
import { type Caller, callRest, callTool, type Door } from './door-parity.js';

export const USERNAME = 'qa-user@sidcorp.test';
export const PASSWORD = 'Correct-Horse-9!';
export const SHORT = 'viewer1';

/** Stores the two rows every case reads: a long username and password, and a short pair. */
export async function storeCredentials(db: TestDb, projectId: string): Promise<void> {
  const environments = {
    preview: null,
    live: { url: 'https://live.example.test' },
    testCredentials: [
      { label: 'staging admin', username: USERNAME, password: PASSWORD },
      { label: 'viewer', username: SHORT, password: 'v1' },
    ],
  };
  await db.execute(
    sql`UPDATE projects SET environments = ${JSON.stringify(environments)}::jsonb WHERE id = ${projectId}`,
  );
}

let seq = 0;

/** An `open` issue on the project, numbered past every one this process has made. */
export async function anIssue(db: TestDb, projectId: string, ownerId: string): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, 'open', ${ownerId})`);
  return id;
}

/** A comment written straight to the table, so an edit has words to keep. */
export async function aComment(
  db: TestDb,
  issueId: string,
  authorId: string,
  body: string,
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO comments (id, issue_id, author_id, body) VALUES (${id}, ${issueId}, ${authorId}, ${body})`);
  return id;
}

/** What a comment holds now. */
export async function storedBody(db: TestDb, commentId: string): Promise<string | undefined> {
  const rows = (await db.execute(
    sql`SELECT body FROM comments WHERE id = ${commentId}`,
  )) as unknown as Array<{ body: string }>;
  return rows[0]?.body;
}

export type Write = (who: Caller, issueId: string, body: string) => Promise<Door>;
export type Edit = (who: Caller, commentId: string, body: string) => Promise<Door>;

/** The two doors a caller writes a new comment through; the server is read when a door is used, after it has started. */
export const createDoors = (baseUrl: () => string): Record<string, Write> => ({
  'REST POST /api/issues/:id/comments': (who, issueId, body) =>
    callRest(baseUrl(), who.jwt, 'POST', `/api/issues/${issueId}/comments`, { body }),
  'forge_comments create': (who, issueId, body) =>
    callTool(who.pat, 'forge_comments', { action: 'create', data: { issue: issueId, body } }),
});

/** The two doors a caller edits a comment through. */
export const editDoors = (baseUrl: () => string): Record<string, Edit> => ({
  'REST PATCH /api/comments/:id': (who, id, body) =>
    callRest(baseUrl(), who.jwt, 'PATCH', `/api/comments/${id}`, { body }),
  'forge_comments update': (who, id, body) =>
    callTool(who.pat, 'forge_comments', { action: 'update', documentId: id, data: { body } }),
});
