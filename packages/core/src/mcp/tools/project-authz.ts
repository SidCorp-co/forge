/**
 * The project-role gate every MCP tool passes through, device side.
 *
 * `lib.ts` carried these next to the schema plumbing and the principal gates
 * until it reached seven modules and archmap's `no-coordinator-blob` said so.
 * The three files it split into each own one question: who is this (here),
 * which project is this (`project-scope.ts`), and what shape does the tool
 * take (`lib.ts`).
 */

import type { Device } from '../../auth/deviceToken.js';
import { effectiveProjectRole, projectRoleAtLeast } from '../../lib/authz.js';
import { readDeviceClaudeCodeCapabilities } from '../../runners/select.js';

/**
 * Effective-role lookup shared by the device and PAT paths. Returns `null`
 * when the project does not exist. `isMember` = any effective role (viewer
 * counts — use for READ tools); `isWriter` = member or admin (use for
 * mutating tools — viewer is read-only); `isAdmin` = effective project admin
 * (explicit row OR org owner/admin — lib/authz.ts).
 */
export async function loadUserProjectRoleFlags(
  userId: string,
  projectId: string,
): Promise<{ isMember: boolean; isWriter: boolean; isAdmin: boolean } | null> {
  const access = await effectiveProjectRole(userId, projectId);
  if (!access) return null;
  return {
    isMember: access.role !== null,
    isWriter: projectRoleAtLeast(access.role, 'member'),
    isAdmin: projectRoleAtLeast(access.role, 'admin'),
  };
}

// cm:guard THREE device-token policies exist and they DISAGREE — pick deliberately, never by picking a middleware. `/mcp` treats a device as its owner (`assertDeviceOwnerIsMember` reads `device.ownerId`); `requireAnyAuth` does the same by setting `userId = device.ownerId`; `requireUserOrDevice` deliberately does NOT, leaving `userId` unset so `loadProjectAccess` fails closed. Measured 2026-09-01 while asking why a runner box cannot reach REST: the answer was this disagreement, not the fleet's version. Choosing a middleware for a new route therefore chooses a security policy, so say which one you meant.
/**
 * Throw if the device's owner is not a member (or owner) of the project.
 * Surfaced to the MCP caller as an `isError: true` tool result — see the
 * `server.ts` error path.
 */
export async function assertDeviceOwnerIsMember(device: Device, projectId: string): Promise<void> {
  const role = await loadUserProjectRoleFlags(device.ownerId, projectId);
  if (!role) throw new Error('FORBIDDEN: project not found or not accessible');
  if (!role.isMember) {
    throw new Error('FORBIDDEN: device owner is not a member of this project');
  }
}

/**
 * Throw if the device's owner cannot WRITE (effective role below `member` —
 * viewer is read-only across the MCP surface too).
 */
export async function assertDeviceOwnerIsWriter(device: Device, projectId: string): Promise<void> {
  const role = await loadUserProjectRoleFlags(device.ownerId, projectId);
  if (!role) throw new Error('FORBIDDEN: project not found or not accessible');
  if (!role.isWriter) {
    throw new Error('FORBIDDEN: requires project member access (viewer is read-only)');
  }
}

/**
 * Throw if the device's owner is not an effective project admin.
 */
export async function assertDeviceOwnerIsAdmin(device: Device, projectId: string): Promise<void> {
  const role = await loadUserProjectRoleFlags(device.ownerId, projectId);
  if (!role) throw new Error('FORBIDDEN: project not found or not accessible');
  if (!role.isAdmin) {
    throw new Error('FORBIDDEN: requires project admin access');
  }
}

/**
 * Gate for `forge_pm.*` write tools (Epic 3, ISS-19). Caller must:
 *   1. be a member of the project, AND
 *   2. own a `claude-code` runner whose `capabilities.pm` is `true`.
 *
 * The `capabilities.pm` flag is the explicit opt-in that lets a single
 * `claude-code` runner act as the PM agent for the project. The
 * `runners_device_type_uq` partial unique index pins at most one
 * `claude-code` runner per device, so toggling the flag on that row is the
 * only path to enable PM tools for the device.
 */
export async function assertPmActor(device: Device, projectId: string): Promise<void> {
  await assertDeviceOwnerIsWriter(device, projectId);
  const caps = await readDeviceClaudeCodeCapabilities(device.id);
  if (!caps) {
    throw new Error('FORBIDDEN: device has no claude-code runner registered');
  }
  if (caps.pm !== true) {
    throw new Error('FORBIDDEN: PM tools require runner capabilities.pm=true');
  }
}
