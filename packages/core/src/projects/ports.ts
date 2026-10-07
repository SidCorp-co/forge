// What the projects domain needs from modules above it in the context order: the issue-prefix
// aliases the issues kernel owns, and the in-app notice an invitee gets. The composition root fills
// them at boot (`provideProjectOrg` is the pattern).

import type { db } from '../db/client.js';
import type { IssuePrefixShapeError } from '../lib/issue-ref.js';
import { portSlot } from '../lib/port-slot.js';

export type PrefixWriter = Pick<typeof db, 'transaction' | 'select' | 'insert' | 'update'>;

export type AssignPrefixResult =
  | { ok: true; prefix: string }
  | IssuePrefixShapeError
  | { ok: false; reason: 'taken'; holderProjectId: string | null };

interface ProjectsPorts {
  /** Hold the prefix in the issues kernel's alias table; the caller then sets the active prefix. */
  claimIssuePrefix(projectId: string, raw: string, dbi: PrefixWriter): Promise<AssignPrefixResult>;
  notifyInvitee(notice: { userId: string; projectId: string; title: string }): Promise<void>;
  /** Why no project route could address a project by this slug, or null when one can. */
  unaddressableSlug(slug: string): string | null;
}

const slot = portSlot<ProjectsPorts>('projects', 'provideProjectsPorts');
export const provideProjectsPorts = slot.provide;
export const projectsPorts = slot.get;
