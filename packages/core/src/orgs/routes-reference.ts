import { z } from 'zod';
import { describeOperation, empty, fail, json } from '../api-reference/describe.js';
import { memberLenses, orgMemberRoles } from '../db/schema.js';

export const createOrgSchema = z.object({
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase letters, digits, or hyphens')
    .min(3)
    .max(64),
  name: z.string().trim().min(1).max(200),
});

export const patchOrgSchema = z
  .object({ name: z.string().trim().min(1).max(200).optional() })
  .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' });

export const addMemberSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  role: z.enum(orgMemberRoles),
});

// Both fields optional; at least one required. `role` = permission change (with
// owner-tier guards in the handler); `lenses` = soft working-lens assignment,
// orthogonal, deduped, no permission effect.
export const patchMemberSchema = z
  .object({
    role: z.enum(orgMemberRoles).optional(),
    lenses: z.array(z.enum(memberLenses)).max(memberLenses.length).optional(),
  })
  .refine((o) => o.role !== undefined || o.lenses !== undefined, {
    message: 'role or lenses required',
  });

export const orgParamSchema = z.object({ orgId: z.uuid() });
export const memberParamSchema = z.object({ orgId: z.uuid(), userId: z.uuid() });

export const cancelInvitationQuerySchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
});

export const orgMembershipSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  isPersonal: z.boolean(),
  role: z.string(),
  createdAt: z.date(),
});

export const orgSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  isPersonal: z.boolean(),
  createdAt: z.date(),
});

export const createdOrgSchema = orgSchema.extend({ role: z.literal('owner') });

export const orgProjectSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  archivedAt: z.date().nullable(),
  createdAt: z.date(),
});

export const orgMemberSchema = z.object({
  userId: z.string(),
  email: z.string(),
  displayName: z.string().nullable(),
  handle: z.string().nullable().describe('The address of an agent member, null for a person'),
  role: z.string(),
  lenses: z.array(z.string()),
  createdAt: z.date(),
});

export const addedMemberSchema = z.object({
  userId: z.string(),
  role: z.enum(orgMemberRoles),
  createdAt: z.date(),
  email: z.string(),
});

export const invitedSchema = z.object({
  invited: z.literal(true),
  expiresAt: z.date(),
  token: z
    .string()
    .optional()
    .describe('Sent only where mail is not delivered (SMTP debug or test), never in production'),
});

export const pendingInvitationSchema = z.object({
  email: z.string(),
  role: z.enum(orgMemberRoles),
  expiresAt: z.date(),
  createdAt: z.date(),
  inviterEmail: z.string(),
  expired: z.boolean(),
});

export const updatedMemberSchema = z.object({
  userId: z.string(),
  role: z.enum(orgMemberRoles),
  lenses: z.array(z.string()),
  createdAt: z.date(),
});

export const orgMembershipsSchema = z.array(orgMembershipSchema);
export const orgProjectsSchema = z.array(orgProjectSchema);
export const orgMembersSchema = z.array(orgMemberSchema);
export const pendingInvitationsSchema = z.array(pendingInvitationSchema);

const NOT_AN_ORG = 'the organization does not exist';
const OWNER_ONLY = 'the caller is not an owner of the organization';
const ADMIN_ONLY = 'the caller is not an admin of the organization';
const MEMBER_ONLY = 'the caller is not a member of the organization';
const LAST_OWNER = 'the change would leave the organization with no owner';

export const listOrgs = describeOperation({
  summary: 'List the organizations the caller belongs to, with the caller role in each',
  description: 'The personal organization is included and flagged by `isPersonal`.',
  responses: { 200: json(orgMembershipsSchema) },
});

export const createOrg = describeOperation({
  summary: 'Create a team organization owned by the caller',
  responses: {
    201: json(createdOrgSchema, 'The organization, with the caller as its owner'),
    409: fail('SLUG_TAKEN', 'another organization already has this slug'),
  },
});

export const renameOrg = describeOperation({
  summary: 'Rename an organization',
  responses: {
    200: json(orgSchema, 'The organization as stored'),
    403: fail('FORBIDDEN', OWNER_ONLY),
    404: fail('NOT_FOUND', NOT_AN_ORG),
  },
});

export const deleteOrg = describeOperation({
  summary: 'Delete an empty team organization',
  responses: {
    204: empty('Deleted'),
    403: fail('FORBIDDEN', OWNER_ONLY),
    404: fail('NOT_FOUND', NOT_AN_ORG),
    409: fail({
      PERSONAL_ORG_IMMUTABLE: 'a personal organization cannot be deleted',
      ORG_NOT_EMPTY: 'projects still live in the organization; delete or move them first',
    }),
  },
});

export const listOrgProjects = describeOperation({
  summary: 'List the projects an organization holds, by name only',
  description: 'Any member sees which projects exist; reading a project still needs a role on it.',
  responses: {
    200: json(orgProjectsSchema),
    403: fail('FORBIDDEN', MEMBER_ONLY),
    404: fail('NOT_FOUND', NOT_AN_ORG),
  },
});

export const readOrgMembers = describeOperation({
  summary: 'List the members of an organization',
  responses: {
    200: json(orgMembersSchema),
    403: fail('FORBIDDEN', MEMBER_ONLY),
    404: fail('NOT_FOUND', NOT_AN_ORG),
  },
});

export const addOrgMember = describeOperation({
  summary: 'Add a member by email, or invite the address when it has no account',
  description:
    'An existing account is added at once (201). An address with no account gets an email invitation (202), and an invitation can never grant `owner`.',
  responses: {
    201: json(addedMemberSchema, 'The account was added'),
    202: json(invitedSchema, 'No account has this email, so an invitation was issued'),
    403: fail(
      'FORBIDDEN',
      `${ADMIN_ONLY}, or only an owner may grant \`owner\`, or \`owner\` was asked for by email invitation`,
    ),
    404: fail('NOT_FOUND', NOT_AN_ORG),
    409: fail({
      PERSONAL_ORG_IMMUTABLE: 'a personal organization takes no other members',
      ALREADY_MEMBER: 'the account is already a member',
    }),
  },
});

export const listOrgInvitations = describeOperation({
  summary: 'List the invitations an organization has issued and nobody accepted',
  responses: {
    200: json(pendingInvitationsSchema),
    403: fail('FORBIDDEN', ADMIN_ONLY),
    404: fail('NOT_FOUND', NOT_AN_ORG),
  },
});

export const cancelOrgInvitation = describeOperation({
  summary: 'Cancel the pending invitation for an email',
  responses: {
    204: empty('Cancelled'),
    403: fail('FORBIDDEN', ADMIN_ONLY),
    404: fail({
      NOT_FOUND: NOT_AN_ORG,
      INVITATION_NOT_FOUND: 'no pending invitation for this email',
    }),
  },
});

export const patchOrgMember = describeOperation({
  summary: 'Change a member role or working lenses',
  description:
    'Lenses carry no permission, so a lenses-only change is allowed on any member. Granting or taking `owner` is owner-only.',
  responses: {
    200: json(updatedMemberSchema, 'The membership as stored'),
    403: fail(
      'FORBIDDEN',
      `${ADMIN_ONLY}, or an owner-tier role is being changed by someone who is not an owner`,
    ),
    404: fail('NOT_FOUND', `${NOT_AN_ORG}, or the user is not a member`),
    409: fail('LAST_OWNER', LAST_OWNER),
  },
});

export const removeOrgMember = describeOperation({
  summary: 'Remove a member from an organization, or leave it',
  description: 'A member may remove themselves; removing anyone else needs an admin.',
  responses: {
    204: empty('Removed'),
    403: fail(
      'FORBIDDEN',
      `${ADMIN_ONLY} (a member may only remove themselves), or an owner is removed by a non-owner`,
    ),
    404: fail('NOT_FOUND', `${NOT_AN_ORG}, or the user is not a member`),
    409: fail('LAST_OWNER', LAST_OWNER),
  },
});
