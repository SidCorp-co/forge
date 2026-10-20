/**
 * What a runner sends when it ends a job pane that stopped on a question: the end reason, and what
 * the pane asked, read from its own transcript.
 */
import { z } from 'zod';

const text = (max: number) => z.string().min(1).max(max);

/** The most questions one pane's dialog carries, so the most places a blocked job's questions take. */
export const DIALOG_QUESTIONS_MAX = 10;

const optionSchema = z
  .object({ label: text(500), description: z.string().max(2000).optional() })
  .strict();

const dialogQuestionSchema = z
  .object({
    question: text(4000),
    header: z.string().max(200).optional(),
    multiSelect: z.boolean().optional(),
    options: z.array(optionSchema).max(10),
  })
  .strict();

export const paneAskSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('dialog'),
    questions: z.array(dialogQuestionSchema).min(1).max(DIALOG_QUESTIONS_MAX),
  }),
  z.object({ kind: z.literal('permission'), tool: text(200), input: z.string().max(4000) }),
  z.object({ kind: z.literal('unread'), why: text(1000) }),
]);

export type PaneAsk = z.infer<typeof paneAskSchema>;

export const blockedBodySchema = z
  .object({ error: z.string().max(10_000), asked: paneAskSchema })
  .strict();

export type BlockedBody = z.infer<typeof blockedBodySchema>;

/** What a plain failure carrying the blocked phrase stands in for, from a runner that read nothing. */
export const UNREAD_BY_OLDER_RUNNER: PaneAsk = {
  kind: 'unread',
  why: 'this box runs a forge-runner that ends a blocked pane without reading what it asked',
};
