/** The inputs the source door's routes validate, one schema per shape, refused rather than clamped. */

import { z } from 'zod';

export const numberParamSchema = z.object({ number: z.coerce.number().int().positive() });

/** A change request and an issue of this project it links, by key or id (ISS-705). */
export const linkParamSchema = z.object({
  number: z.coerce.number().int().positive(),
  issue: z.string().trim().min(1).max(200),
});

export const checkLogParamSchema = z.object({ checkRunId: z.coerce.number().int().positive() });

/** `lines` is how many trailing lines to keep: rejected outside 1..1000, never clamped. */
export const checkLogQuerySchema = z
  .object({ lines: z.coerce.number().int().min(1).max(1000).optional() })
  .strict();

export const commentBodySchema = z.object({ body: z.string().min(1).max(60_000) }).strict();

/** The branch carrying the change, and the branch it lands on. Push the branch with git first. */
export const openBodySchema = z
  .object({
    head: z.string().min(1).max(300),
    base: z.string().min(1).max(300),
    title: z.string().min(1).max(500),
    body: z.string().min(1).max(60_000).optional(),
    draft: z.boolean().optional(),
  })
  .strict();

/** Host usernames, and GitHub team slugs: GitLab has no team reviewers and refuses them by name. */
export const reviewersBodySchema = z
  .object({
    reviewers: z.array(z.string().min(1).max(100)).min(1).max(25).optional(),
    teamReviewers: z.array(z.string().min(1).max(100)).min(1).max(25).optional(),
  })
  .strict()
  .refine((b) => b.reviewers || b.teamReviewers, {
    message:
      'name `reviewers` (host usernames) or `teamReviewers` (team slugs) — nobody is guessed',
  });

/** On GitLab APPROVE is an approval plus a note, COMMENT a note; REQUEST_CHANGES is refused by name. */
export const reviewBodySchema = z
  .object({
    verdict: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']),
    body: z.string().min(1).max(60_000),
  })
  .strict();

/** A full or abbreviated commit sha; a branch name is `branches/:ref`'s, never guessed from this. */
export const shaParamSchema = z.object({
  sha: z
    .string()
    .regex(
      /^[0-9a-fA-F]{7,64}$/,
      'a commit sha: 7 to 64 hex characters — a branch is read at `branches/:ref/checks`',
    ),
});

/** A branch name, URL-encoded where it holds a slash: `release%2Fstg`. */
export const refParamSchema = z.object({ ref: z.string().min(1).max(300) });

/** A new title, a new description, or both. Nothing else on a change request is edited here. */
export const editBodySchema = z
  .object({
    title: z.string().min(1).max(500).optional(),
    body: z.string().max(60_000).optional(),
  })
  .strict()
  .refine((b) => b.title !== undefined || b.body !== undefined, {
    message: 'name `title`, `body` or both — an edit that changes nothing is not sent',
  });
