import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/describe.js';
import { tableRow } from '../api-reference/rows.js';
import { answerStyles } from '../db/schema.js';
import { preferenceChanges } from '../db/schema-agent-selves.js';

/** Theme, language and the assistant's answer settings as one document. */
export const preferencesSchema = z.object({
  userId: z.string(),
  theme: z.string().describe('system, light or dark'),
  language: z.string().describe('en or vi'),
  answerStyle: z.enum(answerStyles),
  assistantInstructions: z.string().nullable(),
  updatedAt: z.date().nullable(),
});

export const preferenceChangesSchema = z.object({ items: z.array(tableRow(preferenceChanges)) });

export const readPreferences = describeOperation({
  summary: 'Read theme, language and the assistant answer settings, or their defaults',
  responses: { 200: json(preferencesSchema) },
});

export const patchPreferences = describeOperation({
  summary: 'Change theme, language or the assistant answer settings',
  description:
    'At least one field is required. Each assistant setting that is written leaves a row in the change trail.',
  responses: { 200: json(preferencesSchema, 'The preferences as stored') },
});

export const listPreferenceChangeTrail = describeOperation({
  summary: 'List the latest 200 changes to the assistant answer settings, newest first',
  responses: { 200: json(preferenceChangesSchema) },
});

export const restorePreferenceChangeOp = describeOperation({
  summary: 'Put an assistant setting back to the value before one change',
  description: 'Only while the setting still holds the value that change set.',
  responses: {
    200: json(preferencesSchema, 'The preferences after the restore'),
    404: fail('NOT_FOUND', "the change is not in the caller's own trail"),
    409: fail(
      'PREFERENCE_CHANGE_SUPERSEDED',
      'the setting has changed since, so restoring would undo that later change; `details.laterChangeId` names it',
    ),
  },
});
