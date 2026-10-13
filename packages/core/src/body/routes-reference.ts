import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/describe.js';
import { BODY_FORMATS } from './formats.js';

/** One node of a parsed HTML body; an element holds its children. */
export const bodyNodeSchema = z
  .union([
    z.object({ type: z.literal('text'), value: z.string(), raw: z.boolean().optional() }),
    z.object({ type: z.literal('comment') }),
    z.object({
      type: z.literal('element'),
      name: z.string(),
      attrs: z.record(z.string(), z.string()),
      get children() {
        return z.array(bodyNodeSchema);
      },
    }),
  ])
  .meta({ id: 'BodyNode' });

export const bodyPreviewSchema = z.object({
  body: z.string(),
  format: z.enum(BODY_FORMATS),
  warnings: z.array(z.string()),
  text: z.string(),
  nodes: z.array(bodyNodeSchema).nullable(),
});

export const previewBody = describeOperation({
  summary: 'Preview how a body is stored: normalized, with warnings, as text and as nodes',
  description: '`nodes` is the parsed tree for an HTML body and null for markdown.',
  responses: {
    200: json(bodyPreviewSchema),
    400: fail(
      'BODY_INVALID',
      'the HTML body is empty once markup outside the allowlist is removed',
    ),
  },
});
