/**
 * ISS-1056 — the comment is whole or absent: when a file refuses to persist, the files already
 * written and the comment row are removed before the error leaves, so the issue never shows a
 * report with half its attachments.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const attachments = {
  validateCommentAttachment: vi.fn(),
  persistCommentAttachment: vi.fn(),
  discardCommentAttachments: vi.fn(async () => undefined),
};
vi.mock('../../comments/attachment-service.js', () => attachments);

const dbCalls: string[] = [];
const dbMock = {
  insert: vi.fn(() => ({
    values: vi.fn((v: { body: string }) => {
      dbCalls.push(`insert:${v.body.split('\n')[0]}`);
      return {
        returning: vi.fn(async () => [{ id: 'comment-1' }]),
        then: (resolve: (v: unknown) => void) => resolve(undefined),
      };
    }),
  })),
  delete: vi.fn(() => ({
    where: vi.fn(async () => {
      dbCalls.push('delete:comment');
    }),
  })),
};
vi.mock('../../db/client.js', () => ({ db: dbMock }));

const { postWeeklyComment, postWeeklyFailure } = await import('./post.js');

const report = {
  body: 'Assistant weekly reading 2026-09-07..2026-09-14: 3 rows — thin (under 30)\n\nbody',
  files: [
    { name: 'assistant-history-w.json', mime: 'text/plain' as const, text: '{}' },
    { name: 'candidate-x.ts.txt', mime: 'text/plain' as const, text: '// x' },
  ],
};

beforeEach(() => {
  dbCalls.length = 0;
  attachments.validateCommentAttachment.mockReset();
  attachments.persistCommentAttachment.mockReset();
  attachments.discardCommentAttachments.mockClear();
  dbMock.insert.mockClear();
  dbMock.delete.mockClear();
});

describe('postWeeklyComment', () => {
  it('validates every file before the comment exists, then inserts the comment and persists each file', async () => {
    let n = 0;
    attachments.persistCommentAttachment.mockImplementation(async () => ({ id: `att-${++n}` }));
    const out = await postWeeklyComment({ issueId: 'i1', authorId: 'u1', report });
    expect(out).toEqual({ commentId: 'comment-1' });
    expect(attachments.validateCommentAttachment).toHaveBeenCalledTimes(2);
    expect(attachments.persistCommentAttachment).toHaveBeenCalledTimes(2);
    expect(attachments.persistCommentAttachment.mock.calls[0]?.[0]).toMatchObject({
      commentId: 'comment-1',
      name: 'assistant-history-w.json',
      mime: 'text/plain',
      uploaderId: 'u1',
    });
    expect(dbCalls).toEqual([
      'insert:Assistant weekly reading 2026-09-07..2026-09-14: 3 rows — thin (under 30)',
    ]);
    expect(attachments.discardCommentAttachments).not.toHaveBeenCalled();
  });

  it('a file that fails validation leaves nothing: no comment row is ever inserted', async () => {
    attachments.validateCommentAttachment.mockImplementation((f: { name: string }) => {
      if (f.name.endsWith('.txt')) throw new Error('mime refused');
    });
    await expect(postWeeklyComment({ issueId: 'i1', authorId: 'u1', report })).rejects.toThrow(
      'mime refused',
    );
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(attachments.persistCommentAttachment).not.toHaveBeenCalled();
  });

  it('a file that fails to persist removes the files already written and the comment, then rethrows', async () => {
    attachments.persistCommentAttachment
      .mockImplementationOnce(async () => ({ id: 'att-1' }))
      .mockImplementationOnce(async () => {
        throw new Error('disk full');
      });
    await expect(postWeeklyComment({ issueId: 'i1', authorId: 'u1', report })).rejects.toThrow(
      'disk full',
    );
    expect(attachments.discardCommentAttachments).toHaveBeenCalledWith(['att-1']);
    expect(dbCalls).toEqual([
      'insert:Assistant weekly reading 2026-09-07..2026-09-14: 3 rows — thin (under 30)',
      'delete:comment',
    ]);
  });
});

describe('postWeeklyFailure', () => {
  it('posts the one failure line, which never starts with the report head', async () => {
    await postWeeklyFailure({
      issueId: 'i1',
      authorId: 'u1',
      windowId: '2026-09-07..2026-09-14',
      error: { name: 'TypeError', message: 'boom' },
    });
    expect(dbCalls).toEqual([
      'insert:Assistant weekly reading 2026-09-07..2026-09-14 failed: TypeError: boom',
    ]);
  });
});
