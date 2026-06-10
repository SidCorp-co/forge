import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type OrgMemberRole, orgInvitations, organizationMembers } from '../db/schema.js';
import { INVITATION_TTL_MS, generateToken } from '../projects/invitation-token.js';

/**
 * Org-tier email-token invitations — the exact mirror of the project
 * invitation mechanics (projects/invitation-token.ts), pointed at
 * org_invitations / organization_members. Issued only for emails with no
 * Forge account yet; registered users are direct-added.
 */

const MAX_INSERT_RETRIES = 3;

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === '23505'
  );
}

export interface IssueOrgInvitationInput {
  orgId: string;
  inviterId: string;
  email: string;
  role: OrgMemberRole;
}

export async function issueOrgInvitationToken(
  input: IssueOrgInvitationInput,
): Promise<{ token: string; expiresAt: Date }> {
  // Atomically replace any pending invite for (orgId, email) — same tx shape
  // as the project variant so the partial-unique can never fire mid-flight.
  return db.transaction(async (tx) => {
    await tx
      .delete(orgInvitations)
      .where(
        and(
          eq(orgInvitations.orgId, input.orgId),
          eq(orgInvitations.email, input.email),
          sql`${orgInvitations.acceptedAt} IS NULL`,
        ),
      );

    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_INSERT_RETRIES; attempt++) {
      const token = generateToken();
      const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
      try {
        await tx.insert(orgInvitations).values({
          token,
          orgId: input.orgId,
          email: input.email,
          role: input.role,
          inviterId: input.inviterId,
          expiresAt,
        });
        return { token, expiresAt };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        lastErr = err;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error('failed to issue org invitation token after retries');
  });
}

export type ConsumeOrgInvitationResult =
  | { status: 'ok'; orgId: string; role: OrgMemberRole }
  | { status: 'invalid' }
  | { status: 'expired' }
  | { status: 'already_accepted' }
  | { status: 'email_mismatch'; invitedEmail: string };

export async function consumeOrgInvitationToken(
  token: string,
  accepting: { userId: string; email: string },
): Promise<ConsumeOrgInvitationResult> {
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{
      org_id: string;
      email: string;
      role: OrgMemberRole;
      expires_at: Date;
      accepted_at: Date | null;
    }>(
      sql`SELECT org_id, email, role, expires_at, accepted_at
          FROM ${orgInvitations}
          WHERE token = ${token}
          FOR UPDATE`,
    );
    const row = rows[0];
    if (!row) return { status: 'invalid' };
    if (row.accepted_at !== null) return { status: 'already_accepted' };
    if (new Date(row.expires_at).getTime() < Date.now()) return { status: 'expired' };
    if (row.email.toLowerCase() !== accepting.email.toLowerCase()) {
      return { status: 'email_mismatch', invitedEmail: row.email };
    }

    await tx
      .insert(organizationMembers)
      .values({ orgId: row.org_id, userId: accepting.userId, role: row.role })
      .onConflictDoNothing({
        target: [organizationMembers.orgId, organizationMembers.userId],
      });

    await tx
      .update(orgInvitations)
      .set({ acceptedAt: new Date() })
      .where(eq(orgInvitations.token, token));

    return { status: 'ok', orgId: row.org_id, role: row.role };
  });
}
