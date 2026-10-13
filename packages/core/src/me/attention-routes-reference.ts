import { z } from 'zod';
import { describeOperation, json } from '../api-reference/declare/describe.js';

const attentionItem = z.object({
  kind: z.enum([
    'needs_review',
    'awaiting_input',
    'mention',
    'failed_job',
    'pending_skill_update',
    'unseen_draft',
  ]),
  title: z.string(),
  link: z.string().describe('A path in the web app'),
  since: z.string(),
  issueRef: z.string().optional(),
  status: z.string().optional(),
  projectSlug: z.string().optional(),
  projectName: z.string().optional(),
  blockerKind: z
    .string()
    .nullable()
    .optional()
    .describe('Awaiting input only: who can end the wait'),
  questionId: z.string().nullable().optional(),
  cost: z
    .object({
      claimsHeld: z.number().int(),
      workspacesPinned: z.number().int(),
      dependents: z.number().int(),
    })
    .optional()
    .describe('Awaiting input only: what the wait costs meanwhile'),
});

const bucket = z.array(attentionItem);

export const attentionSchema = z.object({
  needsReview: bucket,
  awaitingInput: bucket,
  mentions: bucket,
  failedJobs: bucket,
  pendingSkillUpdates: bucket,
  unseenDrafts: bucket,
  unseenDraftsTotal: z.number().int().describe('The count behind `unseenDrafts`, which is capped'),
  projectTotals: z
    .record(
      z.string(),
      z.object({
        needsReview: z.number().int(),
        awaitingInput: z.number().int(),
        awaitingOutsideBlockers: z.number().int(),
        failedJobs: z.number().int(),
      }),
    )
    .describe('By project slug, the whole count behind the capped buckets'),
  total: z.number().int(),
});

export const readAttention = describeOperation({
  summary: 'Read what needs the caller across every project they can see',
  description:
    'Six buckets, each capped: issues to review, issues waiting for an answer, mentions, failed jobs, pending skill updates and unseen drafts. `projectTotals` counts them whole.',
  responses: { 200: json(attentionSchema) },
});
