import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';

export const accountSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string().nullable(),
  emailVerifiedAt: z.date().nullable(),
  createdAt: z.date(),
  lastFreshAuthAt: z.date().nullable(),
  hasPassword: z.boolean(),
  oauthProviders: z.array(z.string()),
});

export const profileAnswerSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string().nullable(),
});

/** The account-level preferences a client reads on load; the row is absent until the first patch. */
export const accountPreferencesSchema = z.object({
  theme: z.string().describe('system, light or dark'),
  language: z.string().describe('en or vi'),
  notifyOnMention: z.boolean(),
  lastSeenWhatsNew: z.string().nullable(),
  activeOrgId: z.string().nullable(),
  updatedAt: z.date().nullable(),
});

export const readAccount = describeOperation({
  summary: 'Read the signed-in account',
  description: 'The password hash is never sent; `hasPassword` says whether there is one.',
  responses: { 200: json(accountSchema) },
});

export const patchProfile = describeOperation({
  summary: 'Set or clear the name the account is shown as',
  description:
    '`displayName: null` clears it, and other members then read the account as "Another member", never by its address. A name holding an email address is refused.',
  responses: {
    200: json(profileAnswerSchema, 'The profile as stored'),
    400: fail({
      BAD_REQUEST: 'the body is not `{ displayName }`, a name of 1 to 200 characters or null',
      DISPLAY_NAME_HOLDS_AN_ADDRESS: 'the display name holds an email address',
    }),
  },
});

export const readAccountPreferences = describeOperation({
  summary: 'Read the account preferences, or their defaults before any was saved',
  responses: { 200: json(accountPreferencesSchema) },
});

export const patchAccountPreferences = describeOperation({
  summary: 'Change the account preferences the body names',
  description:
    'Only the named fields change. `activeOrgId` must be an organization the caller belongs to; `null` clears it.',
  responses: {
    200: json(accountPreferencesSchema, 'The preferences as stored'),
    400: fail('BAD_REQUEST', 'the body names no field to update'),
    403: fail('FORBIDDEN', 'the caller is not a member of `activeOrgId`'),
    404: fail('NOT_FOUND', '`activeOrgId` is no organization'),
  },
});
