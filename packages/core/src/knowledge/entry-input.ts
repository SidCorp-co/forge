import { z } from 'zod';
import type { knowledgeKinds } from '../db/schema.js';

export const MAX_EMBED_CHARS = 8192;

/** The text a knowledge entry is embedded from — title, blank line, body. */
export const knowledgeEmbedText = (title: string, body: string): string => `${title}\n\n${body}`;
/** What is actually sent to the embeddings service: the embed text cut at MAX_EMBED_CHARS. */
export const knowledgeEmbedInput = (title: string, body: string): string =>
  knowledgeEmbedText(title, body).slice(0, MAX_EMBED_CHARS);

export const knowledgeKindEnum = [
  'overview',
  'scenario',
  'workflow',
  'rule',
  'guide',
  'reference',
  'glossary',
] as const satisfies readonly (typeof knowledgeKinds)[number][];

export const knowledgeInjectionEnum = ['always', 'on_demand', 'none'] as const;
export const knowledgeConfidenceEnum = ['verified', 'inferred', 'deprecated'] as const;
export const knowledgeAuthoredByEnum = ['human', 'agent', 'imported'] as const;

export const slugSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be kebab-case');
export const bodySchema = z
  .string()
  .min(1)
  .max(100_000)
  .refine((s) => s.trim().length > 0, 'body must contain more than whitespace');

export const upsertKnowledgeInputSchema = z.object({
  projectId: z.uuid(),
  slug: slugSchema,
  title: z
    .string()
    .min(1)
    .max(500)
    .refine((s) => s.trim().length > 0, 'title must contain more than whitespace'),
  body: bodySchema,
  kind: z.enum(knowledgeKindEnum).default('guide'),
  injection: z.enum(knowledgeInjectionEnum).default('on_demand'),
  confidence: z.enum(knowledgeConfidenceEnum).default('inferred'),
  authoredBy: z.enum(knowledgeAuthoredByEnum).default('agent'),
  orderIndex: z.number().int().default(0),
  metadata: z.record(z.string(), z.unknown()).optional(),
  /**
   * Left unvalidated here on purpose: an absent key and an explicit `null`
   * both have to survive to `upsertKnowledgeEntries` untouched by zod's
   * `.optional()` collapsing them, because they mean different things to the
   * write — absent leaves the stored condition alone, `null` removes it. The
   * shape itself is refused by `parseReadWhen`, with the field named, rather
   * than by a generic schema failure.
   */
  readWhen: z.unknown().optional(),
});

export type UpsertKnowledgeInput = z.infer<typeof upsertKnowledgeInputSchema>;

export interface UpsertKnowledgeResult {
  id: string;
  slug: string;
  degraded: boolean;
  truncated: boolean;
}
