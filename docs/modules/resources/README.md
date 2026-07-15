# Workspace Resources

Org-scoped shared secrets pool. Today the only resource type is the **Private Keys (SSH)**
pool — a workspace-level `workspace_ssh_keys` table that replaced the old per-project deploy
key, so any project in an org can reuse one physical key instead of minting its own.

## Overview

- An org admin creates a pool key (`generate` a fresh keypair, or `provide` a pasted private
  key) once; any project in that org can then reference it.
- A project holds at most one reference, via a thin `(project_id, ssh_key_id)` row in
  `project_git_credentials` — the project itself never stores key material.
- Migration `0150_workspace_ssh_keys.sql` performed the cutover: it created
  `workspace_ssh_keys`, folded every existing `project_git_credentials` row into the pool
  (deduped per org by fingerprint, or by `public_key`+ciphertext for legacy rows with no
  captured fingerprint), rewired each project's reference to its folded pool row, and only
  then dropped the now-redundant secret columns from `project_git_credentials`. A safety gate
  aborts the migration if any row fails to map to a pool key.

## Core Entities

### `WorkspaceSshKey` (`workspace_ssh_keys`)

| Field | Description |
|-------|-------------|
| `id` | Canonical ID |
| `orgId` | Owning organization |
| `name`, `note` | User-provided label |
| `source` | `forge_generated` \| `user_provided` |
| `keyType` | `ed25519` (only supported type) |
| `publicKey` | Non-secret OpenSSH public key line |
| `privateKeyEnc` | Vault-encrypted (`packages/core/src/integrations/vault.ts`) private key — same `<iv:12><tag:16><ct>` format as `integration_connections.secrets_enc`; decrypted only for a connection test or device provisioning, never returned by the list/get views |
| `fingerprint` | Non-secret SHA256 fingerprint, used for display + dedup; nullable for legacy rows folded in without a captured fingerprint |
| `createdBy` | User who created the key |

Unique index `workspace_ssh_keys_org_fingerprint_uq` on `(org_id, fingerprint)` (partial —
`WHERE fingerprint IS NOT NULL`) dedups identical physical keys within an org; a duplicate
`create` returns `409 DUPLICATE_FINGERPRINT`.

### `ProjectGitCredential` (`project_git_credentials`)

Thin reference: `projectId` (PK) → `sshKeyId` (FK `ON DELETE RESTRICT`). One project picks at
most one pool key; many projects may reference the same key. The `RESTRICT` FK is the
DB-level half of the safe-delete guard below.

## Key Business Flows

### Create a pool key

1. Org admin calls `POST /api/orgs/:orgId/ssh-keys` with `mode: 'generate'` (server mints a
   fresh `ed25519` pair) or `mode: 'provide'` (`{ privateKey }`, a pasted key).
2. Service derives the public key + fingerprint, encrypts the private key via the secret
   vault, and inserts the pool row. Throws `503 VAULT_NOT_CONFIGURED` if
   `INTEGRATION_MASTER_KEY` isn't set, `400 INVALID_PRIVATE_KEY` on a malformed or
   passphrase-protected paste, `409 DUPLICATE_FINGERPRINT` on a matching physical key already
   in the org pool.

### Attach a key to a project

1. Project admin calls `PUT /api/projects/:projectId/git-credential { sshKeyId }`, picking a
   key from their **own** org's pool — a cross-org key is rejected `400 WRONG_ORG`.
2. Upserts the `project_git_credentials` row (one per project).

### Safe delete

`DELETE /api/orgs/:orgId/ssh-keys/:keyId` throws `409 KEY_IN_USE` with the list of
referencing projects when any project still references the key. This is a server-side
pre-check (for a friendly structured error) backed by the DB-level `ON DELETE RESTRICT` FK,
which would otherwise surface as a raw constraint-violation `500` — the same UI-only-guard
gap that Coolify had to patch after the fact (coollabsio/coolify #5524).

### Connection test

Both `POST /api/orgs/:orgId/ssh-keys/:keyId/test` and
`POST /api/projects/:projectId/git-credential/test` decrypt the stored key and run
`git ls-remote` against a caller-supplied (org-level) or the project's own (project-level)
repo URL. The repo URL is validated to an SSH-form remote resolving to a public host before
it reaches the shell-adjacent probe (`git/ssh-host-guard.ts`) — guards against `ext::`
transport RCE and SSRF via a private host.

## API Endpoints

| Method | Endpoint | Principal | Description |
|--------|----------|-----------|--------------|
| `GET` | `/api/orgs/:orgId/ssh-keys` | org member | List the org's pool keys (non-secret view + `usedByProjects`) |
| `POST` | `/api/orgs/:orgId/ssh-keys` | org admin | Create a pool key (`generate` or `provide`) |
| `DELETE` | `/api/orgs/:orgId/ssh-keys/:keyId` | org admin | Safe-delete (`409 KEY_IN_USE` if referenced) |
| `POST` | `/api/orgs/:orgId/ssh-keys/:keyId/test` | org member | Probe reachability against a caller-supplied repo URL |
| `GET` | `/api/projects/:projectId/git-credential` | project member | Non-secret status: repo URL + the referenced pool key's public view |
| `PUT` | `/api/projects/:projectId/git-credential` | project admin | Attach a pool key from the project's own org (`400 WRONG_ORG` cross-org) |
| `POST` | `/api/projects/:projectId/git-credential/test` | project member | Probe the referenced key against the project's own repo URL |
| `DELETE` | `/api/projects/:projectId/git-credential` | project admin | Detach the reference (does not delete the pool key) |

## Cross-Module Touchpoints

| Direction | Module | What | When |
|-----------|--------|------|------|
| Receives from | [issues-pipeline](../issues-pipeline/README.md) | Project's `repoUrl` | Connection test needs an SSH-form remote to probe |
| Emits to | devices / runtime plane | Decrypted private key | Device provisioning dispatch decrypts the referenced pool key to clone the repo |
