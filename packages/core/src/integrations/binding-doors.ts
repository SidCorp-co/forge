/**
 * The binding PATCH and DELETE doors' half of `binding-acts.ts`: which acts a write carries, and the
 * refusal for a reader the predicate withholds them from (ISS-1421 r27, r28).
 */

import type { HTTPException } from 'hono/http-exception';
import type { z } from 'zod';
import { agentAccessTier } from './agent-access.js';
import {
  type BindingAct,
  type BindingReader,
  bindingActs,
  bindingReaderOf,
  type ProjectRole,
  projectIntegrationActs,
  whoMayAll,
} from './binding-acts.js';
import { bindingConfigPatch, splitProviderConfig, type updateSchema } from './provider-schemas.js';
import { getIntegration } from './registry.js';
import { withdrawNulls } from './release-channel-schema.js';
import { noAgentPath } from './route-helpers.js';
import {
  boxGrantNotYours,
  keyNotYours,
  notThisProjectsAdmin,
  orgCredentialNotYours,
  severalNotYours,
} from './who-may-refusals.js';

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

/** What each act a binding write carries is, said after "you may not". */
const ACT_WORDS: Record<BindingAct, string> = {
  change: 'switch this integration or change its settings here',
  grantAgents: "change whether this project's agents may use it",
  saveKey: "change its connection's key or shared settings",
};

/**
 * The acts a PATCH carries, in the order they are named: the binding's own tier (`active` among
 * it), the agents grant, and the connection's key and shared settings. A patch touching none of
 * them is held to the binding's tier.
 */
export function actsCarried(
  patch: BindingPatch,
  tiers: ReturnType<typeof mergedTiers>,
): BindingAct[] {
  const saveKey = tiers.mergedConfig !== undefined || Object.keys(patch.secrets ?? {}).length > 0;
  const grantAgents = patch.agentAccess !== undefined;
  const change =
    tiers.mergedBindingConfig !== undefined ||
    patch.active !== undefined ||
    patch.instructions !== undefined ||
    patch.stages !== undefined ||
    (!saveKey && !grantAgents);
  const carried: BindingAct[] = [];
  if (change) carried.push('change');
  if (grantAgents) carried.push('grantAgents');
  if (saveKey) carried.push('saveKey');
  return carried;
}

/** The refusal of one act the reader may not take, naming the people `bindingActs` names for it. */
function oneNotYours(
  act: BindingAct,
  reader: BindingReader,
  provider: string,
  connection: Owned,
): HTTPException {
  if (act === 'saveKey') return keyNotYours(connection);
  if (act === 'grantAgents' && agentAccessTier(getIntegration(provider)) === 'org-admin') {
    return boxGrantNotYours(provider);
  }
  return notThisProjectsAdmin(reader.role, ACT_WORDS[act]);
}

/**
 * A grant no one may take is refused first, whoever asks; several acts refused at once are answered
 * together, naming who may take them all (ISS-1421 r28, judge-114 on 308).
 */
export function refuseByTier(
  reader: BindingReader,
  binding: { provider: string },
  connection: Owned,
  patch: BindingPatch,
  tiers: ReturnType<typeof mergedTiers>,
): void {
  const acts = bindingActs(reader, connection, binding.provider);
  const carried = actsCarried(patch, tiers);
  if (carried.includes('grantAgents') && acts.whoGrantsAgents === null) {
    throw noAgentPath(binding.provider);
  }
  const refused = carried.filter((act) => !acts[act]);
  const [only] = refused;
  if (!only) return;
  if (refused.length === 1) throw oneNotYours(only, reader, binding.provider, connection);
  throw severalNotYours(
    reader.role,
    refused.map((act) => ACT_WORDS[act]),
    whoMayAll(refused, connection, binding.provider, reader.projectOrgId),
  );
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

/** What a new binding asks beyond connecting it: an agents grant, and an organization owning its connection. */
export interface NewBindingAsks {
  /** "you may not …" for the door itself: connecting, or sharing a connection. */
  act: string;
  grants: boolean;
  orgOwned: boolean;
}

/**
 * The create and share doors' refusal by the same predicate the project's list answers `may` with:
 * a grant no one may take first, then every act the reader may not take named together with who may
 * take them all — an owner or admin of the project's organization wherever one of them needs it,
 * since they are admins of the project (ISS-1421 r28).
 */
export function refuseNewBinding(
  reader: Pick<BindingReader, 'role' | 'projectOrgRole'>,
  provider: string,
  asks: NewBindingAsks,
): void {
  const tier = agentAccessTier(getIntegration(provider));
  if (asks.grants && tier === 'refused') throw noAgentPath(provider);
  const may = projectIntegrationActs(reader);
  const box = tier === 'org-admin';
  // Each act refused, with whether only an organization's owner or admin may take it, and its own refusal.
  const refused: { words: string; orgAdmins: boolean; alone: () => HTTPException }[] = [];
  if (!may.connect) {
    refused.push({
      words: asks.act,
      orgAdmins: false,
      alone: () => notThisProjectsAdmin(reader.role, asks.act),
    });
  }
  if (asks.grants && !(box ? may.grantBoxAgents : may.connect)) {
    refused.push({
      words: "let this project's agents use it",
      orgAdmins: box,
      alone: () => boxGrantNotYours(provider),
    });
  }
  if (asks.orgOwned && !may.changeProjectSettings) {
    refused.push({
      words: 'create a connection its organization owns',
      orgAdmins: true,
      alone: () => orgCredentialNotYours('connect'),
    });
  }
  const [only] = refused;
  if (!only) return;
  if (refused.length === 1) throw only.alone();
  const who = refused.some((r) => r.orgAdmins) ? may.whoGrantsBoxAgents : may.whoConnects;
  throw severalNotYours(
    reader.role,
    refused.map((r) => r.words),
    who,
  );
}
