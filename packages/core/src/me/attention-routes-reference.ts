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
  issueTitle: z.string().optional().describe('Failed job only: the title of its issue'),
  jobType: z.string().optional().describe('Failed job only: its kind of work, as stored'),
  failure: z
    .string()
    .nullable()
    .optional()
    .describe("Failed job only: the classifier's cause, else the job's own error"),
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
  bucketTotals: z
    .object({
      needsReview: z.number().int(),
      awaitingInput: z.number().int(),
      mentions: z.number().int(),
      failedJobs: z.number().int(),
      pendingSkillUpdates: z.number().int(),
      unseenDrafts: z.number().int(),
    })
    .describe('Each bucket counted whole, before its cap'),
  projectTotals: z
    .record(
      z.string(),
      z.object({
        needsReview: z.number().int(),
        awaitingInput: z.number().int(),
        failedJobs: z.number().int(),
        parkedOnly: z
          .number()
          .int()
          .describe("Parked issues of the project the health row's list holds and no bucket lists"),
      }),
    )
    .describe("By project slug, the whole counts the project's Needs you list is made of"),
  total: z.number().int().describe('Every item the buckets hold, listed or not'),
});

export const readAttention = describeOperation({
  summary: 'Read what needs the caller across every project they can see',
  description:
    "Six buckets, each capped unless `expand` names it: issues to review, issues waiting for an answer, mentions, failed jobs, pending skill updates and unseen drafts. `bucketTotals` counts each whole, `total` sums them, and `projectTotals` counts what each project's Needs you list is made of.",
  responses: { 200: json(attentionSchema) },
});
