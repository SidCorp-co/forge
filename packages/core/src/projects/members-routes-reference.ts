import { z } from 'zod';
import { describeOperation, empty, fail, json } from '../api-reference/declare/describe.js';
import { projectMemberRoles, userKinds } from '../db/schema.js';

const roleSchema = z.enum(projectMemberRoles);

const NOT_A_MEMBER = fail('FORBIDDEN', 'the caller is not a member of the project');
const NEEDS_ADMIN = fail('FORBIDDEN', 'the caller is not a project admin');
const NO_PROJECT = fail('NOT_FOUND', 'the project does not exist');

export const memberListSchema = z.array(
  z.object({
    userId: z.string(),
    email: z.string(),
    displayName: z.string().nullable(),
    kind: z.enum(userKinds),
    role: roleSchema,
    createdAt: z.date(),
  }),
);

export const pendingInvitationListSchema = z.array(
  z.object({
    email: z.string(),
    role: roleSchema,
    expiresAt: z.date(),
    createdAt: z.date(),
    inviterEmail: z.string(),
    expired: z.boolean(),
  }),
);

export const membershipSchema = z.object({
  userId: z.string(),
  projectId: z.string(),
  role: roleSchema,
  createdAt: z.date(),
});

export const addedMemberSchema = membershipSchema.extend({ email: z.string().nullable() });

export const invitationIssuedSchema = z.object({
  expiresAt: z.date(),
  token: z.string().optional(),
});

export const listMembers = describeOperation({
  summary: 'List the explicit members of a project, agent accounts included',
  description:
    'People who are only org owners or admins hold implicit admin access and are not rows here. `kind` tells a person from an agent account.',
  responses: {
    200: json(memberListSchema, 'The members and their roles'),
    403: NOT_A_MEMBER,
    404: NO_PROJECT,
  },
});

export const listPendingMemberInvitations = describeOperation({
  summary: 'List the invitations to the project that nobody has accepted yet',
  description:
    'The accept token is never shown. `expired` marks a stale invitation that can still be cancelled.',
  responses: {
    200: json(pendingInvitationListSchema, 'The pending invitations'),
    403: NEEDS_ADMIN,
    404: NO_PROJECT,
  },
});

export const addMember = describeOperation({
  summary: "Add a member of the project's org to the project directly",
  description:
    'Skips the email handshake, so only someone the org already has qualifies. Everyone else is invited.',
  responses: {
    201: json(addedMemberSchema, 'The new membership'),
    403: NEEDS_ADMIN,
    404: NO_PROJECT,
    409: fail({
      NOT_ORG_MEMBER: "the user is not a member of the project's org: invite them by email instead",
      ALREADY_MEMBER: 'the user is a member already',
    }),
  },
});

export const inviteMember = describeOperation({
  summary: 'Invite someone to the project by email',
  description:
    'Sends the invitation email and, for a registered user, a notification. The accept `token` is in the answer only where the server runs with SMTP debugging or under test.',
  responses: {
    201: json(invitationIssuedSchema, 'The invitation and when it expires'),
    403: fail('FORBIDDEN', 'the caller is not a project admin, or their account no longer exists'),
    404: NO_PROJECT,
    409: fail('ALREADY_MEMBER', 'the person with this email is a member already'),
  },
});

export const changeMemberRole = describeOperation({
  summary: "Change a member's role in the project",
  responses: {
    200: json(membershipSchema, 'The membership with its new role'),
    403: NEEDS_ADMIN,
    404: fail('NOT_FOUND', 'the project does not exist, or the user is not a member'),
  },
});

export const cancelMemberInvitation = describeOperation({
  summary: 'Cancel a pending invitation, named by the email it was sent to',
  responses: {
    204: empty('The invitation is cancelled'),
    403: NEEDS_ADMIN,
    404: fail({
      NOT_FOUND: 'the project does not exist',
      INVITATION_NOT_FOUND: 'no pending invitation was sent to this email',
    }),
  },
});

export const removeMember = describeOperation({
  summary: 'Remove a member from the project, or leave it',
  description: 'A member may remove themselves; removing anyone else needs a project admin.',
  responses: {
    204: empty('The member is removed'),
    403: NEEDS_ADMIN,
    404: fail('NOT_FOUND', 'the project does not exist, or the user is not a member'),
  },
});
