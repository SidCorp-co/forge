import { asc } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { sessionAttachments } from '../../db/schema-agent-sessions.js';
import { commentAttachments } from '../../db/schema-comments.js';
import { conversationAttachments } from '../../db/schema-conversations.js';
import { feedbackAttachments } from '../../db/schema-feedback.js';
import { issueAttachments } from '../../db/schema-issues.js';
import { mockups } from '../../db/schema-mockups.js';
import { previewRecordings } from '../../db/schema-preview-recordings.js';
import type { StoredReference } from './upload-migration.js';

/**
 * Every `table.column` holding a path `getStorage().put` answered (ISS-1365): what the upload
 * migration counts as needed. A table that stores an upload and is not here has its files dropped,
 * so `upload-migration.test.ts` fails on a `path`/`storage_path` column missing from this list.
 */
export const UPLOAD_REFERENCE_COLUMNS = [
  'comment_attachments.path',
  'conversation_attachments.path',
  'feedback_attachments.storage_path',
  'issue_attachments.path',
  'mockups.storage_path',
  'preview_recordings.segments',
  'session_attachments.path',
] as const;

type Column = (typeof UPLOAD_REFERENCE_COLUMNS)[number];

const one =
  (column: Column) =>
  (rows: { id: string; path: string }[]): StoredReference[] =>
    rows.map((r) => ({ column, id: r.id, path: r.path }));

/**
 * Every stored path a row still holds, in column then id order. No upload row is soft-deleted: a
 * delete removes the row and its file, an expired or redacted recording empties `segments`, and a
 * row under an archived issue, conversation or project still serves its file, so every row counts.
 */
export async function uploadReferences(): Promise<StoredReference[]> {
  const recordings = await db
    .select({ id: previewRecordings.id, segments: previewRecordings.segments })
    .from(previewRecordings)
    .orderBy(asc(previewRecordings.id));
  return [
    ...one('comment_attachments.path')(
      await db
        .select({ id: commentAttachments.id, path: commentAttachments.path })
        .from(commentAttachments)
        .orderBy(asc(commentAttachments.id)),
    ),
    ...one('conversation_attachments.path')(
      await db
        .select({ id: conversationAttachments.id, path: conversationAttachments.path })
        .from(conversationAttachments)
        .orderBy(asc(conversationAttachments.id)),
    ),
    ...one('feedback_attachments.storage_path')(
      await db
        .select({ id: feedbackAttachments.id, path: feedbackAttachments.storagePath })
        .from(feedbackAttachments)
        .orderBy(asc(feedbackAttachments.id)),
    ),
    ...one('issue_attachments.path')(
      await db
        .select({ id: issueAttachments.id, path: issueAttachments.path })
        .from(issueAttachments)
        .orderBy(asc(issueAttachments.id)),
    ),
    ...one('mockups.storage_path')(
      await db
        .select({ id: mockups.id, path: mockups.storagePath })
        .from(mockups)
        .orderBy(asc(mockups.id)),
    ),
    ...recordings.flatMap((r) =>
      r.segments.map((path) => ({
        column: 'preview_recordings.segments' as const,
        id: r.id,
        path,
      })),
    ),
    ...one('session_attachments.path')(
      await db
        .select({ id: sessionAttachments.id, path: sessionAttachments.path })
        .from(sessionAttachments)
        .orderBy(asc(sessionAttachments.id)),
    ),
  ];
}
