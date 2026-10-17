import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';

/** The invitation token is a secret handed out by email, and it is looked up as the opaque string it is. */
export const invitationTokenParamSchema = z.object({ token: z.string() });

export const pendingInvitationsSchema = z.array(
  z.object({
    kind: z.enum(['project', 'org']),
    token: z.string(),
    name: z.string(),
    inviterEmail: z.string(),
    role: z.string(),
    expiresAt: z.date(),
    createdAt: z.date(),
  }),
);

export const invitationPreviewSchema = z.object({
  projectName: z.string(),
  inviterEmail: z.string(),
  role: z.string(),
  email: z.string(),
  expiresAt: z.date(),
});

export const invitationAcceptedSchema = z.object({ projectId: z.string(), role: z.string() });

export const invitationDismissedSchema = z.object({ dismissed: z.literal(true) });

const USER_GONE = fail('UNAUTHENTICATED', "the caller's account no longer exists");

export const listPendingInvitations = describeOperation({
  summary: 'List the project and org invitations waiting for the caller, newest first',
  description:
    "Matches by the caller's email, case-insensitively. Accepted, dismissed and expired invitations are left out. A `kind` of `project` or `org` says which kind of invitation the token is for.",
  responses: { 200: json(pendingInvitationsSchema, 'The pending invitations'), 401: USER_GONE },
});

export const previewInvitation = describeOperation({
  summary: 'Read a project invitation before accepting it, by its token',
  description: 'Public: the token in the invitation email is the credential.',
  responses: {
    200: json(invitationPreviewSchema, 'Who invited, to what project and as which role'),
    404: fail('INVITATION_NOT_FOUND', 'no invitation has this token'),
    410: fail({
      ALREADY_ACCEPTED: 'the invitation was accepted already',
      EXPIRED_TOKEN: 'the invitation has expired',
    }),
  },
});

export const acceptInvitation = describeOperation({
  summary: 'Accept a project invitation and become a member',
  description: 'The caller must hold the email address the invitation was sent to.',
  responses: {
    200: json(invitationAcceptedSchema, 'The project joined and the role held there'),
    401: USER_GONE,
    403: fail('INVITATION_EMAIL_MISMATCH', 'the invitation was sent to a different email address'),
    404: fail('INVITATION_NOT_FOUND', 'no invitation has this token'),
    409: fail({
      FORGE_IS_NOT_A_MEMBER: "the signed-in account is Forge's own, which is never a member",
      AGENT_ADDRESS_RESERVED: 'the signed-in account is an agent account, which no invitation adds',
    }),
    410: fail({
      ALREADY_ACCEPTED: 'the invitation was accepted already',
      EXPIRED_TOKEN: 'the invitation has expired',
    }),
  },
});

export const declineInvitation = describeOperation({
  summary: 'Decline a project invitation',
  description:
    'Idempotent while the invitation is not accepted. Only the address it was sent to may decline it.',
  responses: {
    200: json(invitationDismissedSchema, 'The invitation is dismissed'),
    401: USER_GONE,
    404: fail('NOT_FOUND', "no pending invitation with this token for the caller's email"),
  },
});
