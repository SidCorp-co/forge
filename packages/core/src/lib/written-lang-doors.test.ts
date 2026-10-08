import { createEntityCommentRequestSchema } from '@forge/contracts/comments';
import {
  createFeedbackRequestSchema,
  feedbackMessageRequestSchema,
} from '@forge/contracts/feedback';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { submitReportSchema } from '../agent-reports/reports.js';
import { commentBodySchema, commentCreateSchema } from '../comments/body-input.js';
import { issueCreateSchema, issuePatchSchema } from '../issues/request-schemas.js';
import { revisionFields } from '../requirements/route-kit.js';

// Every door a person or a model writes text through takes the language it was written in, and
// refuses a language outside en | vi by name rather than storing a guess (migration 0456).

const DOORS: Array<[string, z.ZodType, Record<string, unknown>]> = [
  ['issue create', issueCreateSchema, { title: 'Sửa lỗi đăng nhập' }], // i18n-allow: Vietnamese text under test
  ['issue patch', issuePatchSchema, { title: 'Sửa lỗi đăng nhập' }], // i18n-allow: Vietnamese text under test
  ['feedback create', createFeedbackRequestSchema, { kind: 'bug', title: 't', screen: '/x' }],
  ['feedback message', feedbackMessageRequestSchema, { audience: 'internal', text: 't' }],
  ['issue comment', commentCreateSchema, { body: 'b' }],
  ['issue comment edit', commentBodySchema, { body: 'b' }],
  ['entity comment', createEntityCommentRequestSchema, { intent: 'note', body: 'b' }],
  ['requirement revision', z.strictObject(revisionFields), { reason: 'r', criteria: [] }],
  [
    'agent report',
    submitReportSchema,
    {
      projectId: '00000000-0000-4000-8000-000000000000',
      kind: 'bug',
      target: 'skill',
      summary: 's',
    },
  ],
];

describe('the language a writer declares, at every door it writes through', () => {
  it.each(DOORS)('%s keeps vi as sent', (_door, schema, body) => {
    const parsed = schema.safeParse({ ...body, writtenLang: 'vi' });
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect((parsed.data as { writtenLang?: string }).writtenLang).toBe('vi');
  });

  it.each(DOORS)('%s refuses fr by name', (_door, schema, body) => {
    const parsed = schema.safeParse({ ...body, writtenLang: 'fr' });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.message)).toContain(
      'WRITTEN_LANG_INVALID: writtenLang must be one of en, vi; got "fr"',
    );
  });
});
