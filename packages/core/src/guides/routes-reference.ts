import { z } from 'zod';
import { describeOperation, fail, json, raw } from '../api-reference/declare/describe.js';
import { CORE_GUIDE_AUDIENCES } from './types.js';

export const guideSlugParamSchema = z.object({ slug: z.string() });

/** Any string that names no known provider is refused by the handler with its own 400. */
export const orgGuideParamSchema = z.object({ orgId: z.uuid() });
export const orgGuideSlugParamSchema = z.object({ orgId: z.uuid(), slug: z.string() });
export const orgProviderParamSchema = z.object({ orgId: z.uuid(), provider: z.string() });

export const upsertGuideSchema = z.object({
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(500),
  body: z.string().min(1).max(200000),
});

const guideEntry = z.object({
  slug: z.string(),
  audience: z.enum(CORE_GUIDE_AUDIENCES),
  title: z.string(),
  summary: z.string(),
  version: z.number().int(),
});

export const guideSchema = guideEntry.extend({
  body: z.string().describe('The guide as markdown'),
});

export const guideIndexSchema = z.object({
  guides: z.array(guideEntry),
  corpus: z.object({
    complete: z.boolean(),
    listed: z.string(),
    elsewhere: z.string(),
    reach: z.string(),
    authority: z.string(),
    cliServed: z.array(z.object({ slug: z.string(), covers: z.string() })),
  }),
});

export const guideEnvelopeSchema = z.object({ guide: guideSchema });

export const orgGuideIndexSchema = z.object({ guides: z.array(guideEntry) });

export const storedGuideSchema = z.object({
  guide: z.object({
    slug: z.string(),
    title: z.string(),
    summary: z.string(),
    version: z.number().int(),
    updatedAt: z.date(),
  }),
});

export const deletedGuideSchema = z.object({ deleted: z.boolean() });

const ADMIN_ONLY = 'the caller is not an admin or owner of the organization';

export const listGuideIndex = describeOperation({
  summary: 'List the guides this server serves, without their bodies',
  description:
    'No sign-in. `corpus` says the list is not the whole set: the method guides are served by the forge CLI.',
  responses: { 200: json(guideIndexSchema) },
});

export const readLlmsTxt = describeOperation({
  summary: 'Read the guide index as llms.txt, with a link to every guide as markdown',
  description: 'No sign-in.',
  responses: { 200: raw('text/plain; charset=utf-8', 'The index as plain text') },
});

export const readGuide = describeOperation({
  summary: 'Read one guide',
  description:
    'No sign-in. With a `.md` suffix on the slug the body is the markdown itself, as `text/markdown`; without it the answer is the JSON below.',
  responses: {
    200: json(guideEnvelopeSchema, 'The guide', 'text/markdown'),
    404: fail('NOT_FOUND', 'no guide has this slug; the message lists the valid ones'),
  },
});

export const listOrgGuides = describeOperation({
  summary: "List the guides as an organization sees them, with the org's own integration guides",
  responses: {
    200: json(orgGuideIndexSchema),
    403: fail('FORBIDDEN', ADMIN_ONLY),
  },
});

export const readOrgGuide = describeOperation({
  summary: "Read one guide as an organization sees it, preferring the org's own version",
  responses: {
    200: json(guideEnvelopeSchema),
    403: fail('FORBIDDEN', ADMIN_ONLY),
    404: fail('NOT_FOUND', 'no guide has this slug; the message lists the valid ones'),
  },
});

export const putIntegrationGuide = describeOperation({
  summary: "Write an organization's own guide for an integration provider",
  description: 'The stored version number goes up by one on every write.',
  responses: {
    200: json(storedGuideSchema, 'The guide as stored'),
    400: fail('BAD_REQUEST', 'the provider is not a known integration provider'),
    403: fail('FORBIDDEN', ADMIN_ONLY),
  },
});

export const deleteIntegrationGuideOp = describeOperation({
  summary: "Delete an organization's own guide, so the provider falls back to the code default",
  responses: {
    200: json(deletedGuideSchema, '`deleted` says whether the organization had one'),
    400: fail('BAD_REQUEST', 'the provider is not a known integration provider'),
    403: fail('FORBIDDEN', ADMIN_ONLY),
  },
});
