import { z } from 'zod';
import { describeOperation, json } from '../api-reference/declare/describe.js';
import { STUCK_ISSUE_KINDS } from '../projects/stuck-issue-kinds.js';

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
  jobId: z.string().optional().describe('Failed job only: the job a person retries from the row'),
  jobType: z.string().optional().describe('Failed job only: its kind of work, as stored'),
  failure: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Failed job only: the cause as a stored code, the classifier's else the job's error; null where neither is a code",
    ),
  stuckKind: z
    .enum(STUCK_ISSUE_KINDS)
    .optional()
    .describe("The reason a stuck-issue notice tells the item's issue by, where one stands"),
  stuckOwedBy: z
    .string()
    .optional()
    .describe('`waiting_on_others` only: the person the park waits for'),
  failedJob: z
    .object({ jobType: z.string(), failure: z.string().nullable() })
    .optional()
    .describe(
      "Needs review and awaiting input only: the reader's latest failed job on the issue, which is listed here rather than as a failed job",
    ),
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
        awaitingAsked: z
          .number()
          .int()
          .describe('Of `awaitingInput`, the issues holding an open question'),
        failedJobs: z.number().int(),
        parkedOnly: z
          .number()
          .int()
          .describe("Parked issues of the project the health row's list holds and no bucket lists"),
        parkedAsked: z
          .number()
          .int()
          .describe('Of `parkedOnly`, the issues holding an open question'),
        stuckOnly: z
          .number()
          .int()
          .describe('Issues a stuck-issue notice stands for that none of the counts above holds'),
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
