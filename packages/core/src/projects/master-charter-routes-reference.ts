import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';

const charterFields = {
  version: z.number(),
  goal: z.string(),
  rules: z.array(z.string()),
  declaredBy: z.string(),
  declaredAt: z.string(),
};

/** One version of a charter as it is written down. */
export const charterVersionSchema = z.object(charterFields);

/** The charter in force, or `declared: false` with every field empty for a project that has none. */
export const charterReadSchema = z.union([
  z.object({ declared: z.literal(true), ...charterFields }),
  z.object({
    declared: z.literal(false),
    version: z.null(),
    goal: z.null(),
    rules: z.array(z.string()),
    declaredBy: z.null(),
    declaredAt: z.null(),
  }),
]);

export const charterVersionsSchema = z.object({
  versions: z.array(charterVersionSchema),
  returned: z.number(),
});

export const charterWrittenSchema = z.object({
  declared: z.literal(true),
  created: z.boolean(),
  ...charterFields,
});

const NOT_A_MEMBER = fail('FORBIDDEN', 'the caller has no access to the project');

export const readMasterCharter = describeOperation({
  summary: "Read what the project's master is for and the rules that bind it",
  description: 'A project that has declared nothing answers 200 with `declared: false`, not 404.',
  responses: { 200: json(charterReadSchema, 'The current charter'), 403: NOT_A_MEMBER },
});

export const listMasterCharterVersions = describeOperation({
  summary: 'List every version the master charter has had, newest first',
  responses: { 200: json(charterVersionsSchema, 'Every version, unbounded'), 403: NOT_A_MEMBER },
});

export const writeMasterCharter = describeOperation({
  summary: "Declare the project's master charter",
  description:
    "The body is `{ goal, rules }`: a non-empty `goal` string and an array of rule strings, with no other field. A body with the same content as the current charter appends no version and answers `created: false`. A person's write: an agent credential is refused before the body is read.",
  responses: {
    200: json(charterWrittenSchema, 'The charter now in force'),
    400: fail('MASTER_CHARTER_SHAPE', 'the body is not a charter; `details.field` names the field'),
    403: fail({
      FORBIDDEN: 'the caller has no access to the project',
      MASTER_CHARTER_IS_A_PERSONS_WRITE:
        "the credential is an agent's, and only a person declares a charter",
    }),
  },
});
