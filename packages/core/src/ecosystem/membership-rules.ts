import { SCHEMA_BASE } from '@forge/contracts/project-config';
import type { MembershipDocument, MembershipState } from './schema.js';

export const MEMBERSHIP_VERBS = ['accept', 'decline', 'leave', 'remove'] as const;
export type MembershipVerb = (typeof MEMBERSHIP_VERBS)[number];

type MembershipSide = 'project' | 'steward';

export const TRANSITIONS: Readonly<
  Record<
    MembershipVerb,
    { from: MembershipState; to: MembershipState; side: MembershipSide; reason: boolean }
  >
> = {
  accept: { from: 'invited', to: 'active', side: 'project', reason: false },
  decline: { from: 'invited', to: 'declined', side: 'project', reason: false },
  leave: { from: 'active', to: 'left', side: 'project', reason: true },
  remove: { from: 'active', to: 'removed', side: 'steward', reason: true },
};

export interface MembershipRow {
  id: string;
  ecosystemId: string;
  projectId: string;
  state: MembershipState;
  invitedBy: string;
  invitedAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
  endedAt: Date | null;
  endedReason: string | null;
}

export function membershipDocument(row: MembershipRow): MembershipDocument {
  return {
    $schema: `${SCHEMA_BASE}/membership-v1.json`,
    version: 1,
    ecosystem: row.ecosystemId,
    project: row.projectId,
    state: row.state,
    invitedBy: row.invitedBy,
    invitedAt: row.invitedAt.toISOString(),
    ...(row.decidedBy ? { decidedBy: row.decidedBy } : {}),
    ...(row.decidedAt ? { decidedAt: row.decidedAt.toISOString() } : {}),
    ...(row.endedAt ? { endedAt: row.endedAt.toISOString() } : {}),
    ...(row.endedReason ? { endedReason: row.endedReason } : {}),
  };
}
