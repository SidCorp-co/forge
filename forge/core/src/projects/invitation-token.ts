import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type ProjectMemberRole, projectInvitations, projectMembers } from '../db/schema.js';

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const MAX_INSERT_RETRIES = 3;

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === '23505'
  );
}

export interface IssueInvitationInput {
  projectId: string;
  inviterId: string;
  email: string;
  role: ProjectMemberRole;
}

export interface IssueInvitationResult {
  token: string;
  expiresAt: Date;
}

export async function issueInvitationToken(
  input: IssueInvitationInput,
): Promise<IssueInvitationResult> {
  // Atomically drop any existing pending invite for (projectId, email) and
  // insert a fresh row. Wrapping delete + insert in a single transaction closes
  // the window where a concurrent call could land a pending row between the
  // two statements and trigger the partial-unique index.
  return db.transaction(async (tx) => {
    await tx
      .delete(projectInvitations)
      .where(
        and(
          eq(projectInvitations.projectId, input.projectId),
          eq(projectInvitations.email, input.email),
          sql`${projectInvitations.acceptedAt} IS NULL`,
        ),
      );

    // Token PK is 32 bytes of CSPRNG, so a 23505 on the PK is astronomically
    // unlikely — we still retry a couple of times to stay robust. The partial-
    // unique on (project_id, email) is already impossible here because the
    // preceding DELETE runs in the same tx.
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_INSERT_RETRIES; attempt++) {
      const token = generateToken();
      const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
      try {
        await tx.insert(projectInvitations).values({
          token,
          projectId: input.projectId,
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
      : new Error('failed to issue invitation token after retries');
  });
}

export type ConsumeInvitationResult =
  | { status: 'ok'; projectId: string; role: ProjectMemberRole }
  | { status: 'invalid' }
  | { status: 'expired' }
  | { status: 'already_accepted' }
  | { status: 'email_mismatch'; invitedEmail: string };

export async function consumeInvitationToken(
  token: string,
  accepting: { userId: string; email: string },
): Promise<ConsumeInvitationResult> {
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{
      project_id: string;
      email: string;
      role: ProjectMemberRole;
      expires_at: Date;
      accepted_at: Date | null;
    }>(
      sql`SELECT project_id, email, role, expires_at, accepted_at
          FROM ${projectInvitations}
          WHERE token = ${token}
          FOR UPDATE`,
    );
    const row = rows[0];
    if (!row) return { status: 'invalid' };

    if (row.accepted_at !== null) {
      return { status: 'already_accepted' };
    }

    if (new Date(row.expires_at).getTime() < Date.now()) {
      return { status: 'expired' };
    }

    if (row.email.toLowerCase() !== accepting.email.toLowerCase()) {
      return { status: 'email_mismatch', invitedEmail: row.email };
    }

    // ON CONFLICT DO NOTHING: if the invitee is already a member, don't raise
    // 23505 — a caught error would still leave the Postgres transaction in
    // aborted state and fail the subsequent UPDATE. DO NOTHING keeps the tx
    // healthy so we can still mark the invite consumed.
    await tx
      .insert(projectMembers)
      .values({
        userId: accepting.userId,
        projectId: row.project_id,
        role: row.role,
      })
      .onConflictDoNothing({
        target: [projectMembers.userId, projectMembers.projectId],
      });

    await tx
      .update(projectInvitations)
      .set({ acceptedAt: new Date() })
      .where(eq(projectInvitations.token, token));

    return { status: 'ok', projectId: row.project_id, role: row.role };
  });
}
