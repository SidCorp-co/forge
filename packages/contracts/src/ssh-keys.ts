// Shared Private Keys (workspace SSH pool) contract surface (ISS-628).
//
// One typed contract for the org-scoped SSH key pool + project Git-access
// reference so core (zod schemas) and web-v2 (api.ts/types.ts) consume the
// same shapes instead of hand-mirroring them (the old
// `packages/web-v2/src/features/runners/types.ts` GitCredentialView/
// GitCredentialTestResult duplication this issue retires).
//
// Secret bytes are excluded BY CONSTRUCTION: `WorkspaceSshKeyView` never
// carries `privateKeyEnc` — only the public half + fingerprint. Timestamps are
// `string` (ISO) — these are the JSON-serialized client shapes.

import type { schema } from '@forge/core/public';

/** `'forge_generated' | 'user_provided'`. */
export type SshKeySource = schema.ProjectGitCredentialSource;
/** `'ed25519'`. */
export type WorkspaceSshKeyType = schema.WorkspaceSshKeyType;

/** A project that references a pool key — used for the `usedByProjects` list. */
export interface SshKeyUsedByProject {
  id: string;
  slug: string;
  name: string;
}

/** `GET /api/orgs/:orgId/ssh-keys` row / `POST` response — non-secret view. */
export interface WorkspaceSshKeyView {
  id: string;
  orgId: string;
  name: string;
  note: string | null;
  source: SshKeySource;
  keyType: WorkspaceSshKeyType;
  publicKey: string;
  fingerprint: string | null;
  createdAt: string;
  usedByProjects: SshKeyUsedByProject[];
}

/** `POST /api/orgs/:orgId/ssh-keys` request body. */
export type SshKeyCreateInput =
  | { mode: 'generate'; name: string; note?: string | null }
  | { mode: 'provide'; name: string; note?: string | null; privateKey: string };

/** `GET /api/projects/:id/git-credential` — the project's resolved pool reference. */
export type ProjectGitAccessView =
  | { configured: false }
  | { configured: true; repoUrl: string | null; key: WorkspaceSshKeyView };

/** `PUT /api/projects/:id/git-credential` request body. */
export interface ProjectGitAccessInput {
  sshKeyId: string;
}

/** `POST .../ssh-keys/:keyId/test` (org) and `.../git-credential/test` (project)
 *  — deploy-key reachability probe (git ls-remote). */
export interface SshConnTestResult {
  ok: boolean;
  code: 'authenticated' | 'auth_denied' | 'host_unreachable' | 'not_found' | 'timeout' | 'error';
  message: string;
  headSha?: string;
}

/** `DELETE /api/orgs/:orgId/ssh-keys/:keyId` 409 body when the key is in use
 *  (server-side safe-delete guard — never a UI-only hide). */
export interface SshKeyInUseError {
  code: 'KEY_IN_USE';
  referencedBy: SshKeyUsedByProject[];
}
