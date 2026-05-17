/**
 * Personal Access Token (PAT) shapes — mirror `publicShape()` in
 * `packages/core/src/pat/routes.ts`. The plaintext is only ever present on
 * the create/rotate response and is never persisted client-side beyond the
 * lifetime of the reveal modal.
 */

export type PatScope = 'read' | 'write';

export interface Pat {
  id: string;
  name: string;
  prefix: string;
  scopes: PatScope[];
  projectIds: string[] | null;
  expiresAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
}

export interface PatWithPlaintext extends Pat {
  plaintext: string;
}

export interface PatAuditEntry {
  id: string;
  tool: string | null;
  action: string | null;
  projectId: string | null;
  resultCode: string | null;
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface CreatePatInput {
  name: string;
  scopes?: PatScope[];
  projectIds?: string[] | null;
  expiresAt?: string | null;
}
