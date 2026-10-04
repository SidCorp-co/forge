// What the projects domain needs from modules above it in the context order: the issue-prefix
// aliases the issues kernel owns, and the in-app notice an invitee gets. The composition root fills
// them at boot (`provideProjectOrg` is the pattern).

import type { db } from '../db/client.js';
import type { IssuePrefixShapeError } from '../lib/issue-ref.js';

export type PrefixWriter = Pick<typeof db, 'transaction' | 'select' | 'insert' | 'update'>;

export type AssignPrefixResult =
  | { ok: true; prefix: string }
  | IssuePrefixShapeError
  | { ok: false; reason: 'taken'; holderProjectId: string | null };

export interface ProjectsPorts {
  /** Hold the prefix in the issues kernel's alias table; the caller then sets the active prefix. */
  claimIssuePrefix(projectId: string, raw: string, dbi: PrefixWriter): Promise<AssignPrefixResult>;
  notifyInvitee(notice: { userId: string; projectId: string; title: string }): Promise<void>;
}

let ports: ProjectsPorts | null = null;

export function provideProjectsPorts(given: ProjectsPorts): void {
  ports = given;
}

export function projectsPorts(): ProjectsPorts {
  if (!ports) {
    throw new Error(
      'projects: no ports were provided; the process entry calls provideProjectsPorts before it serves',
    );
  }
  return ports;
}
