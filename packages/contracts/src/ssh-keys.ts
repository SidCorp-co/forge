import type { schema } from '@forge/core/public';

export type SshKeySource = schema.ProjectGitCredentialSource;
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

export interface SshConnTestResult {
  ok: boolean;
  code: 'authenticated' | 'auth_denied' | 'host_unreachable' | 'not_found' | 'timeout' | 'error';
  message: string;
  headSha?: string;
}

export interface SshKeyInUseError {
  code: 'KEY_IN_USE';
  referencedBy: SshKeyUsedByProject[];
}
