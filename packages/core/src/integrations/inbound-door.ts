/**
 * ISS-1140 — the inbound door. Health answered the outbound direction alone, so three dead doors
 * all read `ok` with zero deliveries: the provider never called, it called here and was turned
 * away, or it calls an address that is not this core. Each needs a different person to act, and
 * nothing here asserts who called: a turned-away call arrived unauthenticated.
 */

import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { integrationDeliveries, type ObservedEndpoint } from '../db/schema.js';

/**
 * `not_expected`: silence is not a fault here. `open`: something came through. `elsewhere`: an
 * address that is not this binding's. `unaddressed`: none held, or the hook is off. `unreadable`:
 * could not be asked. `unaddressable`: this core cannot say what URL this binding needs. `silent`.
 */
export type InboundDoorState =
  | 'not_expected'
  | 'open'
  | 'elsewhere'
  | 'unaddressed'
  | 'unreadable'
  | 'unaddressable'
  | 'silent';

/** `accepted` got through; `refused` counts RECORDS, one per code per bucket, so it is a floor on the calls turned away — attributed to nobody, and never `failed`, which is a delivery accepted and then not processed and which the outbound breaker counts. */
export interface InboundDoorTraffic {
  accepted: number;
  lastAcceptedAt: Date | null;
  refusalRecords: number;
  lastRecordedRefusalAt: Date | null;
  lastRefusalCode: string | null;
}

const REFUSED: string = 'refused';

/**
 * One turn-away record per binding per code per ten minutes. The door is unauthenticated, and the
 * bucket is what stops that being a write amplifier: one row is all an operator needs.
 */
const REFUSAL_BUCKET_MS = 10 * 60_000;

export async function readInboundDoorTraffic(bindingId: string): Promise<InboundDoorTraffic> {
  const [totals] = await db
    .select({
      accepted: sql<number>`count(*) filter (where ${integrationDeliveries.status} <> ${REFUSED})::int`,
      lastAcceptedAt: sql<Date | null>`max(${integrationDeliveries.createdAt}) filter (where ${integrationDeliveries.status} <> ${REFUSED})`,
      refused: sql<number>`count(*) filter (where ${integrationDeliveries.status} = ${REFUSED})::int`,
      lastRefusedAt: sql<Date | null>`max(${integrationDeliveries.createdAt}) filter (where ${integrationDeliveries.status} = ${REFUSED})`,
    })
    .from(integrationDeliveries)
    .where(
      and(
        eq(integrationDeliveries.bindingId, bindingId),
        eq(integrationDeliveries.direction, 'inbound'),
      ),
    );

  const refusalRecords = Number(totals?.refused ?? 0);
  const [latestRefusal] = refusalRecords
    ? await db
        .select({ code: integrationDeliveries.errorMessage })
        .from(integrationDeliveries)
        .where(
          and(
            eq(integrationDeliveries.bindingId, bindingId),
            eq(integrationDeliveries.direction, 'inbound'),
            eq(integrationDeliveries.status, 'refused'),
          ),
        )
        .orderBy(desc(integrationDeliveries.createdAt))
        .limit(1)
    : [];

  return {
    accepted: Number(totals?.accepted ?? 0),
    lastAcceptedAt: totals?.lastAcceptedAt ? new Date(totals.lastAcceptedAt) : null,
    refusalRecords,
    lastRecordedRefusalAt: totals?.lastRefusedAt ? new Date(totals.lastRefusedAt) : null,
    lastRefusalCode: latestRefusal?.code ?? null,
  };
}

/**
 * The refusal code and NOT the request body: the body is whatever an unauthenticated caller sent,
 * and storing it would make the door a place to put bytes. The bucketed request id lands on
 * `integration_deliveries_binding_request_id_uq`, so a repeat in the same bucket is dropped.
 */
export async function recordTurnedAwayInboundCall(args: {
  bindingId: string;
  code: string;
  eventName: string;
  at?: Date;
}): Promise<void> {
  const at = args.at ?? new Date();
  const bucket = Math.floor(at.getTime() / REFUSAL_BUCKET_MS);
  await db
    .insert(integrationDeliveries)
    .values({
      bindingId: args.bindingId,
      direction: 'inbound',
      eventName: args.eventName,
      status: 'refused',
      payload: {},
      errorMessage: args.code,
      requestId: `door-refusal:${args.code}:${bucket}`,
      createdAt: at,
      completedAt: at,
    })
    // The index this rides on is PARTIAL — `WHERE request_id IS NOT NULL` — and Postgres will not
    // match a conflict target to a partial index unless the target carries the same predicate.
    .onConflictDoNothing({
      target: [integrationDeliveries.bindingId, integrationDeliveries.requestId],
      where: isNotNull(integrationDeliveries.requestId),
    });
}

/**
 * `inboundUnprompted` is the provider's declaration that a bound resource makes it call in by
 * itself. Not `canReceiveWebhook`, which Sentry declares while calling only on an error.
 */
export function inboundDoorState(args: {
  inboundUnprompted: boolean;
  expectedUrl: string | null;
  observed: ObservedEndpoint | null;
  traffic: InboundDoorTraffic;
}): InboundDoorState {
  if (!args.inboundUnprompted) return 'not_expected';
  const { observed } = args;
  if (observed?.readError !== undefined) return 'unreadable';
  if (observed) {
    if (observed.url === null || observed.url === '') return 'unaddressed';
    if (observed.active === false) return 'unaddressed';
    if (args.expectedUrl !== null && !sameEndpoint(observed.url, args.expectedUrl))
      return 'elsewhere';
  }
  // Traffic proves the door opens; it does not excuse an ADDRESS check that could not be made.
  if (args.expectedUrl === null) return 'unaddressable';
  return args.traffic.accepted > 0 ? 'open' : 'silent';
}

/**
 * A trailing slash and a change of case in the host are the same URL to every HTTP client, and
 * calling a binding broken over one would be a false alarm. Anything else is a different door.
 */
function sameEndpoint(a: string, b: string): boolean {
  const normalize = (raw: string): string => {
    try {
      const url = new URL(raw);
      return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}${url.search}`;
    } catch {
      return raw.trim().replace(/\/+$/, '');
    }
  };
  return normalize(a) === normalize(b);
}

const NOT_OVERRIDDEN = new Set(['degraded', 'error', 'needs_reauth', 'needs_scope']);

/**
 * A stored status already worse than `ok` passes through untouched: the outbound probe found
 * something an operator must act on first, and a door verdict replacing it would lose that.
 */
export function healthWithInboundDoor(
  stored: string | null,
  state: InboundDoorState,
): string | null {
  if (state === 'not_expected' || state === 'open') return stored;
  if (stored !== null && NOT_OVERRIDDEN.has(stored.toLowerCase())) return stored;
  return 'degraded';
}

/**
 * The silent case is the point of the module: Forge can say nothing reached this address and
 * cannot say whether the provider called elsewhere or not at all, so it names the read that can.
 */
export function describeInboundDoor(args: {
  state: InboundDoorState;
  traffic: InboundDoorTraffic;
  expectedUrl: string | null;
  observed: ObservedEndpoint | null;
  /** Where the provider records what it sent — the read Forge cannot make itself. */
  providerDeliveryLog: string;
}): string | null {
  const { state, traffic, expectedUrl, observed } = args;
  if (state === 'not_expected') return null;

  const turnedAway =
    traffic.refusalRecords > 0
      ? ` At least ${traffic.refusalRecords} call${traffic.refusalRecords === 1 ? '' : 's'} carrying this provider's webhook header reached this door and ${traffic.refusalRecords === 1 ? 'was' : 'were'} turned away — ${traffic.refusalRecords} record${traffic.refusalRecords === 1 ? '' : 's'}, at most one per refusal code per ten minutes, so the true count is higher where calls repeated. The last one RECORDED was at ${traffic.lastRecordedRefusalAt?.toISOString() ?? 'a time nothing recorded'} with ${traffic.lastRefusalCode ?? 'no code recorded'}; a turned-away call is unauthenticated, so Forge cannot say who sent it.`
      : '';

  switch (state) {
    case 'open':
      return (
        `${traffic.accepted} inbound deliver${traffic.accepted === 1 ? 'y has' : 'ies have'} come through this door, ` +
        `the last at ${traffic.lastAcceptedAt?.toISOString() ?? 'a time nothing recorded'}.${turnedAway}`
      );
    case 'unaddressable':
      return (
        `Nothing here could build the inbound URL this binding needs, so what the provider holds cannot be compared against it. ` +
        `This core resolves no public API origin — PUBLIC_API_BASE_URL, OAUTH_REDIRECT_BASE and APP_BASE_URL are all unset — ` +
        `or this binding's project carries no slug. Until one is set, the address half of this door is unjudged.${turnedAway}`
      );
    case 'unreadable':
      return (
        `Forge could not ask the provider where it calls in: ${observed?.readError ?? 'no reason recorded'}. ` +
        `Until that read succeeds, nothing here says whether this door is addressed correctly.${turnedAway}`
      );
    case 'unaddressed':
      return (
        (observed?.url
          ? `The provider holds a webhook for this App and it is switched off, so it will call nothing.`
          : `The provider holds no webhook address for this App, so it will call nothing.`) +
        ` This binding needs ${expectedUrl ?? 'an inbound URL nothing here could build'}.${turnedAway}`
      );
    case 'elsewhere':
      return (
        `The provider is addressed at ${observed?.url}, and this binding needs ${expectedUrl ?? 'an inbound URL nothing here could build'}. ` +
        `Nothing it sends can reach this binding until those are the same address.${turnedAway}`
      );
    default:
      return (
        `This door is addressed at ${expectedUrl ?? 'an inbound URL nothing here could build'} and nothing has ever come through it.` +
        `${turnedAway} Whether the provider called an address that is not this core, or did not call, ` +
        `is not something Forge can see from here — ${args.providerDeliveryLog} is the read that answers it.`
      );
  }
}
