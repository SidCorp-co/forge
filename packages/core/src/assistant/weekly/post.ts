/**
 * ISS-1056 — the one write the weekly reading makes: a kernel-authored comment on the pinned
 * issue (the shape `pipeline/autonomous-rescue-comment.ts` posts) with the week's files attached.
 * A report is whole or absent: when an attachment fails, what was written is removed before the
 * error leaves, so the runner's failure comment is the only thing left (codex F1 on the plan).
 */

import {
  deleteComment,
  discardCommentAttachments,
  persistCommentAttachment,
  postIssueNotice,
  validateCommentAttachment,
} from '../../comments/index.js';
import { failureLine, type WeeklyReport } from '../bench/history/report.js';

export interface PostWeeklyArgs {
  issueId: string;
  /** The project's assistant handle: the reading is the assistant's own, posted by no person (ISS-17). */
  authorId: string;
  report: WeeklyReport;
}

/** The comment and every file, or nothing. */
export async function postWeeklyComment(args: PostWeeklyArgs): Promise<{ commentId: string }> {
  const files = args.report.files.map((f) => ({ ...f, bytes: Buffer.from(f.text, 'utf8') }));
  for (const f of files) validateCommentAttachment({ name: f.name, mime: f.mime, bytes: f.bytes });
  const inserted = await postIssueNotice({
    issueId: args.issueId,
    authorId: args.authorId,
    body: args.report.body,
  });
  const written: string[] = [];
  try {
    for (const f of files) {
      const a = await persistCommentAttachment({
        commentId: inserted.id,
        name: f.name,
        mime: f.mime,
        bytes: f.bytes,
        uploaderId: args.authorId,
        uploaderDeviceId: null,
      });
      written.push(a.id);
    }
  } catch (err) {
    await discardCommentAttachments(written);
    await deleteComment(inserted.id);
    throw err;
  }
  return { commentId: inserted.id };
}

/** The one line a failed week leaves on the issue. */
export async function postWeeklyFailure(args: {
  issueId: string;
  authorId: string;
  windowId: string;
  error: { name: string; message: string };
}): Promise<void> {
  await postIssueNotice({
    issueId: args.issueId,
    authorId: args.authorId,
    body: failureLine(args.windowId, args.error),
  });
}
