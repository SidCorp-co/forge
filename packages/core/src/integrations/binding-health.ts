import { type Said, sayEn } from '@forge/contracts/said';
import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type IntegrationBindingHealthRow,
  integrationBindingHealth,
  type ObservedEndpoint,
} from '../db/schema.js';
import { getAdapter } from './registry.js';
import { type BindingWithConnection, updateConnection } from './store.js';
import type { AdapterContext, HealthStatus } from './types.js';

/**
 * One half of what a health check learned. `detail` left out leaves the stored sentence as it is;
 * `null` clears it.
 */
export interface HealthPart {
  status: HealthStatus;
  detail?: Said | null;
}

/**
 * A health check's reading, split by whose it is (ISS-983). `connection` is what is true of the
 * credential, and every binding of the connection reads it alike: recognised or not, its scope, the
 * host answering. `binding` is what is true of this binding's own target — its repository seen, its
 * hooks, its deploy targets, its site — and lands in that binding's own health row, where no other
 * project reads it. A check that never reached the target names no `binding` and leaves the last one standing;
 * one that never called the provider (the binding names no target) names no `connection`.
 */
export async function recordHealth(
  ctx: Pick<AdapterContext, 'connectionId' | 'bindingId'>,
  reading: {
    connection?: HealthPart;
    binding?: HealthPart;
    /** The connection config the check resolved, written with its health. */
    connectionConfig?: Record<string, unknown>;
  },
): Promise<void> {
  const at = new Date();
  if (reading.connection) {
    await updateConnection(ctx.connectionId, {
      ...(reading.connectionConfig ? { config: reading.connectionConfig } : {}),
      lastHealthStatus: reading.connection.status,
      ...(reading.connection.detail !== undefined
        ? { lastHealthDetail: reading.connection.detail }
        : {}),
      lastHealthAt: at,
    });
  }
  if (reading.binding) {
    await updateBindingHealth(ctx.bindingId, {
      status: reading.binding.status,
      detail: reading.binding.detail ?? null,
      at,
    });
  }
}

/**
 * Writes what a check observed of one binding's own target into its row of
 * `integration_binding_health`, the adapter's own table: never the binding document, so a probe never
 * moves the binding's `revision`. A field left out keeps what is stored.
 */
export async function updateBindingHealth(
  bindingId: string,
  patch: {
    status?: string | null;
    detail?: Said | null;
    at?: Date | null;
    inboundEndpointObserved?: ObservedEndpoint | null;
  },
): Promise<void> {
  const set: Partial<typeof integrationBindingHealth.$inferInsert> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.detail !== undefined) {
    set.detail = patch.detail === null ? null : sayEn(patch.detail);
    set.says = patch.detail;
  }
  if (patch.at !== undefined) set.checkedAt = patch.at;
  if (patch.inboundEndpointObserved !== undefined) {
    set.inboundEndpointObserved = patch.inboundEndpointObserved;
  }
  if (Object.keys(set).length === 0) return;
  await db
    .insert(integrationBindingHealth)
    .values({ bindingId, ...set })
    .onConflictDoUpdate({ target: integrationBindingHealth.bindingId, set });
}

/** A pair with its binding's own health row beside it: `null` where no check has reached it yet. */
export type BindingWithHealth<P extends BindingWithConnection = BindingWithConnection> = P & {
  health: IntegrationBindingHealthRow | null;
};

/** Each pair with its binding's own health row, read in one query. */
export async function withBindingHealth<P extends BindingWithConnection>(
  pairs: readonly P[],
): Promise<BindingWithHealth<P>[]> {
  const ids = pairs.map((p) => p.binding.id);
  const rows = ids.length
    ? await db
        .select()
        .from(integrationBindingHealth)
        .where(inArray(integrationBindingHealth.bindingId, ids))
    : [];
  const byId = new Map(rows.map((r) => [r.bindingId, r]));
  return pairs.map((p) => ({ ...p, health: byId.get(p.binding.id) ?? null }));
}

/** A reading as a project reads it: one status, its sentence in English and as said, and when. */
export interface HealthReading {
  status: string | null;
  detail: string | null;
  says: Said | null;
  at: Date | null;
}

const CREDENTIAL_HOLDS = new Set(['ok', 'healthy', 'success']);

/** Whether this provider's health check reads a binding's own target (`healthReadsBinding`). */
export function healthReadsBinding(provider: string): boolean {
  return getAdapter(provider)?.healthReadsBinding === true;
}

/**
 * The health one binding reads: its connection's where the credential itself is at fault, which
 * every binding of it shares alike; else its own. A binding of a provider whose check reads the
 * binding's target, and that no check has reached yet, reads unverified — never another binding's
 * verdict, and never its connection's `ok` standing in for a target nobody looked at.
 *
 * The only reading of a binding's health: nothing takes `lastHealthStatus` off the connection row for
 * a binding (ISS-983).
 */
export function bindingHealth(
  pair: Pick<BindingWithHealth, 'binding' | 'connection' | 'health'>,
): HealthReading {
  const { binding, connection, health } = pair;
  const credential: HealthReading = {
    status: connection.lastHealthStatus ?? null,
    detail: connection.lastHealthDetail ?? null,
    says: connection.lastHealthSays ?? null,
    at: connection.lastHealthAt ?? null,
  };
  const status = credential.status?.toLowerCase() ?? null;
  if (status !== null && !CREDENTIAL_HOLDS.has(status)) return credential;
  if (health?.status) {
    return {
      status: health.status,
      detail: health.detail ?? null,
      says: health.says ?? null,
      at: health.checkedAt ?? null,
    };
  }
  if (healthReadsBinding(binding.provider)) {
    return { status: null, detail: null, says: null, at: null };
  }
  return credential;
}
