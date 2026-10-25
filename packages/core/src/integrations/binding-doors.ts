/**
 * The binding PATCH and DELETE doors' half of `binding-acts.ts`: which tier a write touches, and the
 * refusal for a reader the predicate withholds it from (ISS-1421 r27).
 */

import type { z } from 'zod';
import {
  type BindingReader,
  bindingActs,
  bindingReaderOf,
  type ProjectRole,
} from './binding-acts.js';
import { bindingConfigPatch, splitProviderConfig, type updateSchema } from './provider-schemas.js';
import { withdrawNulls } from './release-channel-schema.js';
import { keyNotYours, notThisProjectsAdmin } from './route-helpers.js';

type BindingPatch = z.infer<typeof updateSchema>;
type Owned = { ownerType: 'user' | 'org'; ownerId: string; config: unknown };

/**
 * The patch's config split into its tiers, each merged over what is stored: a provider's binding-
 * scoped keys (Coolify's resourceUuid and branch follow the project) and the shared connection's rest.
 * Re-validated against the stored provider, so a PATCH never strips another provider's fields.
 */
export function mergedTiers(
  binding: { provider: string; config: unknown },
  connection: { config: unknown },
  patch: BindingPatch,
): { mergedConfig?: Record<string, unknown>; mergedBindingConfig?: Record<string, unknown> } {
  if (!patch.config) return {};
  const tiers = splitProviderConfig(
    binding.provider,
    bindingConfigPatch(binding.provider, patch.config),
  );
  return {
    ...(Object.keys(tiers.connection).length > 0 && {
      mergedConfig: withdrawNulls({
        ...((connection.config ?? {}) as object),
        ...tiers.connection,
      }),
    }),
    ...(Object.keys(tiers.binding).length > 0 && {
      mergedBindingConfig: withdrawNulls({
        ...((binding.config ?? {}) as object),
        ...tiers.binding,
      }),
    }),
  };
}

/**
 * Refuses each tier the reader may not write: the binding's own tier, `active` among them, is a
 * project admin's; the connection's key and shared settings are whoever `saveKey` names. A patch
 * touching neither is held to the binding's tier.
 */
export function refuseByTier(
  reader: BindingReader,
  binding: { provider: string },
  connection: Owned,
  patch: BindingPatch,
  tiers: ReturnType<typeof mergedTiers>,
): void {
  const acts = bindingActs(reader, connection, binding.provider);
  const touchesKey =
    tiers.mergedConfig !== undefined || Object.keys(patch.secrets ?? {}).length > 0;
  const touchesBinding =
    tiers.mergedBindingConfig !== undefined ||
    patch.active !== undefined ||
    patch.instructions !== undefined ||
    patch.agentAccess !== undefined ||
    patch.stages !== undefined ||
    !touchesKey;
  if (touchesBinding && !acts.change) {
    throw notThisProjectsAdmin(reader.role, 'switch this integration or change its settings here');
  }
  if (touchesKey && !acts.saveKey) throw keyNotYours(connection);
}

/** A disconnect, refused to a reader who may not change the binding. */
export async function assertMayDisconnect(
  userId: string,
  projectId: string,
  role: ProjectRole,
  existing: { binding: { provider: string }; connection: Owned },
): Promise<void> {
  const reader = await bindingReaderOf(userId, projectId, role);
  if (!bindingActs(reader, existing.connection, existing.binding.provider).change) {
    throw notThisProjectsAdmin(role, 'disconnect this integration from it');
  }
}
