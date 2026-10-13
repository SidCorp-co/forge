import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';
import { orgMemberRoles } from '../db/schema.js';

/** The token is an opaque string from the invitation mail. */
export const invitationTokenParamSchema = z.object({ token: z.string() });

export const invitationPreviewSchema = z.object({
  orgName: z.string(),
  inviterEmail: z.string(),
  role: z.enum(orgMemberRoles),
  email: z.string(),
  expiresAt: z.date(),
});

export const acceptedInvitationSchema = z.object({
  orgId: z.string(),
  role: z.enum(orgMemberRoles),
});

export const dismissedInvitationSchema = z.object({ dismissed: z.literal(true) });

const ALREADY_ACCEPTED = 'the invitation was already accepted';
const EXPIRED = 'the invitation has expired';

export const previewOrgInvitation = describeOperation({
  summary: 'Read an invitation from the link in its mail, with no sign-in',
  responses: {
    200: json(invitationPreviewSchema),
    404: fail('INVITATION_NOT_FOUND', 'no invitation has this token'),
    410: fail({ ALREADY_ACCEPTED, EXPIRED_TOKEN: EXPIRED }),
  },
});

export const acceptOrgInvitation = describeOperation({
  summary: 'Accept an invitation and join the organization',
  description: 'The signed-in account must have the email the invitation was sent to.',
  responses: {
    200: json(acceptedInvitationSchema, 'The organization joined and the role held'),
    403: fail('INVITATION_EMAIL_MISMATCH', 'the invitation was sent to another email address'),
    404: fail('INVITATION_NOT_FOUND', 'no invitation has this token'),
    410: fail({ ALREADY_ACCEPTED, EXPIRED_TOKEN: EXPIRED }),
  },
});

export const declineOrgInvitation = describeOperation({
  summary: 'Decline an invitation sent to the signed-in email',
  description: 'Declining twice is the same as once.',
  responses: {
    200: json(dismissedInvitationSchema),
    404: fail(
      'NOT_FOUND',
      'no pending invitation has this token and the signed-in email, or it was accepted',
    ),
  },
});
