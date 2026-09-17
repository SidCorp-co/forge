/**
 * ISS-1085 slice 2 — core's outbound half of the Forge/Sentry loop.
 *
 * Two operations and no more: read one Sentry issue's detail, and set one Sentry issue's status.
 * Together they are what lets a Forge issue that closed carrying a merged SHA tell Sentry so,
 * instead of a person copying an id between two tabs.
 *
 * Every call here goes through `withDelivery`, so an operator reading the binding's delivery log
 * sees the request, the response and the duration — including the refusals, which is the point: a
 * dispatch that named a target this binding does not declare is a thing somebody has to see, and a
 * refusal that leaves no row is indistinguishable from a call nobody made.
 *
 * There is still NO inbound surface. Ingesting Sentry event text is slice 3's, and the chokepoint
 * it owes is written on `SentryIssueDetail` in `types.ts`.
 */

import { sanitizeUntrusted } from '../../prompt/sanitize.js';
import { recordDelivery, updateDelivery } from '../deliveries.js';
import { isPreviousCredentialValid } from '../rotation.js';
import { updateConnection } from '../store.js';
import type {
  AdapterContext,
  HealthStatus,
  OutboundDispatchInput,
  OutboundDispatchResult,
} from '../types.js';
import { sentryIssueUrl, sentryOrgIssuesUrl } from './endpoints.js';
// cm:edge contract -> packages/core/src/integrations/sentry/listing.ts — the listing's vocabulary
// and its pure decisions live there; this file makes the call and owns the delivery row.
import {
  assertListLimit,
  confinementRefusal,
  listQuery,
  nextSentryCursor,
  SENTRY_LIST_MAX_PAGES,
  SentryListingFailed,
  type SentryIssueListing,
  type SentryListRefusal,
  type SentryListRequest,
} from './listing.js';
import { type ResolvedSentryTarget, resolveSentryTarget } from './targets.js';
import {
  SENTRY_ISSUE_STATUSES,
  type SentryConfig,
  type SentryIssueDetail,
  type SentryIssueStatus,
  type SentrySecrets,
} from './types.js';

const CALL_TIMEOUT_MS = 15_000;

// cm:why re-exported rather than left to `listing.js` alone: `issues.ts` is the module the adapter,
// the tests and the intake path already import from, and splitting a file for a LINE BUDGET must
// not move every caller's import. The definitions live in one place; this is the door.
export {
  nextSentryCursor,
  SENTRY_LIST_DEFAULT_LIMIT,
  SENTRY_LIST_DEFAULT_QUERY,
  SENTRY_LIST_MAX_LIMIT,
  SENTRY_LIST_MAX_PAGES,
  SentryListingFailed,
  type SentryIssueListing,
  type SentryListRefusal,
  type SentryListRequest,
} from './listing.js';

export const SENTRY_ISSUE_READ = 'sentry.issue.read';
export const SENTRY_ISSUE_SET_STATUS = 'sentry.issue.set-status';
export const SENTRY_ISSUE_LIST = 'sentry.issue.list';

/** Every event name `dispatchOutbound` implements. Named in the refusal for anything else. */
export const SENTRY_DISPATCH_EVENTS = [
  SENTRY_ISSUE_READ,
  SENTRY_ISSUE_SET_STATUS,
  SENTRY_ISSUE_LIST,
] as const;

export type SentryAdapterContext = AdapterContext<SentryConfig, SentrySecrets>;

/**
 * One dispatch's request, and the SAME shape the delivery row records.
 *
 * That identity is what makes a retry a replay rather than a fresh guess: the retry route hands
 * the recorded payload back to the worker, which dispatches it unchanged.
 */
export interface SentryIssueRequest {
  issueId: string;
  targetLabel?: string;
  status?: SentryIssueStatus;
}

export interface SentryIssueCall {
  result: OutboundDispatchResult;
  issue: SentryIssueDetail;
}

type Attempt =
  | { kind: 'ok'; body: unknown; link: string | null }
  | { kind: 'refused'; status: number; health: HealthStatus; reason: string };

async function attempt(
  url: string,
  token: string,
  method: 'GET' | 'PUT',
  body?: Record<string, unknown>,
): Promise<Attempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    if (res.ok) return { kind: 'ok', body: await res.json(), link: res.headers.get('link') };
    // cm:guard 401 and 403 are different verdicts and must not collapse — a 403 read as
    // `needs_reauth` sends the operator to replace a token that works (ISS-924).
    if (res.status === 401) {
      return {
        kind: 'refused',
        status: 401,
        health: 'needs_reauth',
        reason: 'the Sentry auth token was rejected',
      };
    }
    if (res.status === 403) {
      return {
        kind: 'refused',
        status: 403,
        health: 'needs_scope',
        reason: 'the Sentry auth token lacks the scope this call needs (issue:read / issue:write)',
      };
    }
    return {
      kind: 'refused',
      status: res.status,
      health: 'error',
      reason: `Sentry answered HTTP ${res.status}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One call to Sentry, with the ISS-405 previous-token retry and the health verdict it earns.
 *
 * The health write is not bookkeeping: a dispatch that keeps being refused while the connection
 * card stays green is a state that lies about itself, and the healthcheck only runs on its own
 * schedule.
 */
async function callSentry(
  ctx: SentryAdapterContext,
  url: string,
  method: 'GET' | 'PUT',
  body?: Record<string, unknown>,
  /** Filled with the response's `Link` header where the caller cares; the other two do not. */
  out?: { link: string | null },
): Promise<unknown> {
  const authToken = ctx.secrets?.authToken;
  if (!authToken) {
    // The same rule the catch below states, at the one refusal that precedes it: a connection left
    // green through a call that could not be made is a state that lies about itself. `healthcheck`
    // in `adapter.ts` writes `error` for this exact condition, and a dispatch that stayed silent
    // here would leave the card disagreeing with the delivery log beside it.
    await updateConnection(ctx.connectionId, {
      lastHealthStatus: 'error',
      lastHealthAt: new Date(),
    });
    throw new Error('sentry: this connection holds no auth token, so no call can be made');
  }
  let res: Attempt;
  try {
    res = await attempt(url, authToken, method, body);
    if (
      res.kind === 'refused' &&
      res.status === 401 &&
      ctx.secrets.previousAuthToken &&
      isPreviousCredentialValid(ctx.secrets)
    ) {
      res = await attempt(url, ctx.secrets.previousAuthToken, method, body);
    }
  } catch (err) {
    // A timeout, a DNS failure or a body that is not JSON never produced an HTTP status, so it
    // never reached the verdict below — and a connection left green through a call that could not
    // be made is the contradiction this function exists to prevent.
    await updateConnection(ctx.connectionId, {
      lastHealthStatus: 'error',
      lastHealthAt: new Date(),
    });
    const reason = err instanceof Error ? err.message : 'unknown error';
    throw new Error(`sentry: ${method} ${url} — ${reason}`);
  }
  await updateConnection(ctx.connectionId, {
    lastHealthStatus: res.kind === 'ok' ? 'ok' : res.health,
    lastHealthAt: new Date(),
  });
  if (res.kind !== 'ok') {
    throw new Error(`sentry: ${method} ${url} — ${res.reason}`);
  }
  if (out) out.link = res.link;
  return res.body;
}

async function withDelivery<T>(
  ctx: SentryAdapterContext,
  eventName: string,
  payload: Record<string, unknown>,
  requestId: string | undefined,
  run: () => Promise<{ value: T; response: unknown; externalId?: string }>,
): Promise<{ result: OutboundDispatchResult; value: T }> {
  const deliveryId = await recordDelivery({
    bindingId: ctx.bindingId,
    direction: 'outbound',
    eventName,
    payload,
    ...(requestId ? { requestId } : {}),
    status: 'pending',
  });
  const started = Date.now();
  try {
    const out = await run();
    const durationMs = Date.now() - started;
    await updateDelivery(deliveryId, {
      status: 'ok',
      response: out.response,
      durationMs,
      completedAt: new Date(),
    });
    return {
      result: { deliveryId, durationMs, ...(out.externalId ? { externalId: out.externalId } : {}) },
      value: out.value,
    };
  } catch (err) {
    await updateDelivery(deliveryId, {
      status: 'failed',
      errorMessage: err instanceof Error ? err.message : 'unknown error',
      durationMs: Date.now() - started,
      completedAt: new Date(),
    });
    throw err;
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? sanitizeUntrusted(value) : null;
}

/** Sentry serializes `count` and `userCount` as strings on some versions and numbers on others. */
function count(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function projectIssue(body: unknown, fallbackId: string): SentryIssueDetail {
  const raw = (body ?? {}) as Record<string, unknown>;
  const project = (raw.project ?? {}) as Record<string, unknown>;
  const metadata = (raw.metadata ?? {}) as Record<string, unknown>;
  return {
    id: typeof raw.id === 'string' ? raw.id : String(raw.id ?? fallbackId),
    shortId: typeof raw.shortId === 'string' ? raw.shortId : null,
    status: typeof raw.status === 'string' ? raw.status : null,
    substatus: typeof raw.substatus === 'string' ? raw.substatus : null,
    level: typeof raw.level === 'string' ? raw.level : null,
    count: count(raw.count),
    userCount: count(raw.userCount),
    firstSeen: typeof raw.firstSeen === 'string' ? raw.firstSeen : null,
    lastSeen: typeof raw.lastSeen === 'string' ? raw.lastSeen : null,
    permalink: typeof raw.permalink === 'string' ? raw.permalink : null,
    projectSlug: typeof project.slug === 'string' ? project.slug : null,
    title: text(raw.title),
    culprit: text(raw.culprit),
    metadataValue: text(metadata.value),
  };
}

function assertIssueId(issueId: unknown): string {
  if (typeof issueId === 'string' && issueId.trim() !== '') return issueId;
  throw new Error(
    'sentry: this dispatch names no `issueId`, and an issue cannot be addressed without one',
  );
}

/**
 * The issue Sentry answered with belongs to the target that was named, or the call is refused.
 *
 * A Sentry issue is addressed under its ORGANIZATION and nothing narrower, so two targets sharing
 * one org — which is exactly what forge-dev has, `forge-core` and `forge-web` both under `canawan`
 * — build the identical URL. Without this the label would be decorative: naming `forge-core` while
 * addressing a web issue would resolve, read, and on the write path RESOLVE THE WRONG PROJECT'S
 * issue, silently (ISS-1085).
 *
 * A target declaring no `projectSlug` is org-wide by the operator's own declaration, so there is
 * nothing to confine it to and nothing to check.
 */
function assertTargetHoldsIssue(
  issue: SentryIssueDetail,
  target: ResolvedSentryTarget,
  issueId: string,
): void {
  if (!target.projectSlug) return;
  if (issue.projectSlug === null) {
    throw new Error(
      `sentry: target "${target.label}" is scoped to project ${target.projectSlug}, and Sentry's answer for issue ${issueId} names no project — this call cannot be confined to that target`,
    );
  }
  if (issue.projectSlug !== target.projectSlug) {
    throw new Error(
      `sentry: issue ${issueId} belongs to project ${issue.projectSlug}, and target "${target.label}" is scoped to ${target.projectSlug}`,
    );
  }
}

function assertStatus(status: unknown): SentryIssueStatus {
  if (typeof status === 'string' && (SENTRY_ISSUE_STATUSES as readonly string[]).includes(status)) {
    return status as SentryIssueStatus;
  }
  throw new Error(
    `sentry: ${JSON.stringify(status)} is not a Sentry issue status — Sentry accepts ${SENTRY_ISSUE_STATUSES.join(', ')}`,
  );
}

/** Read one Sentry issue's detail. */
export async function readSentryIssue(
  ctx: SentryAdapterContext,
  input: SentryIssueRequest,
  requestId?: string,
): Promise<SentryIssueCall> {
  const { result, value } = await withDelivery(
    ctx,
    SENTRY_ISSUE_READ,
    { ...input },
    requestId,
    async () => {
      const issueId = assertIssueId(input.issueId);
      const target = resolveSentryTarget(ctx.config, input.targetLabel);
      const url = sentryIssueUrl(ctx.config.host, target.organizationSlug, issueId);
      const issue = projectIssue(await callSentry(ctx, url, 'GET'), issueId);
      assertTargetHoldsIssue(issue, target, issueId);
      return {
        value: issue,
        response: issue,
        ...(issue.shortId ? { externalId: issue.shortId } : {}),
      };
    },
  );
  return { result, issue: value };
}

/** Set one Sentry issue's status, and answer with the issue as Sentry now holds it. */
export async function setSentryIssueStatus(
  ctx: SentryAdapterContext,
  input: SentryIssueRequest,
  requestId?: string,
): Promise<SentryIssueCall> {
  const { result, value } = await withDelivery(
    ctx,
    SENTRY_ISSUE_SET_STATUS,
    { ...input },
    requestId,
    async () => {
      const issueId = assertIssueId(input.issueId);
      const status = assertStatus(input.status);
      const target = resolveSentryTarget(ctx.config, input.targetLabel);
      const url = sentryIssueUrl(ctx.config.host, target.organizationSlug, issueId);
      // Read BEFORE writing: the confinement check needs the issue's project, and a wrong-project
      // write cannot be taken back by discovering it afterwards.
      assertTargetHoldsIssue(
        projectIssue(await callSentry(ctx, url, 'GET'), issueId),
        target,
        issueId,
      );
      const issue = projectIssue(await callSentry(ctx, url, 'PUT', { status }), issueId);
      return {
        value: issue,
        response: issue,
        ...(issue.shortId ? { externalId: issue.shortId } : {}),
      };
    },
  );
  return { result, issue: value };
}

/**
 * Every unresolved Sentry issue a target holds, confined to that target.
 *
 * TWO halves, and the second is not redundant. The query carries `project:<slug>` so Sentry does
 * the narrowing, and every answer is then checked against the target again — because a filter that
 * is only ever ASKED for is a filter nobody has verified, and `forge-core` and `forge-web` both sit
 * under the `canawan` organization, so an org-scoped listing reaches both. An answer that fails
 * confinement is not dropped quietly: it is named in the delivery row by its Sentry issue id and
 * the project it belongs to, which is what an operator needs to fix a mis-declared target.
 */
export async function listSentryIssues(
  ctx: SentryAdapterContext,
  input: SentryListRequest,
  requestId?: string,
): Promise<SentryIssueListing> {
  let target!: ResolvedSentryTarget;
  let refused: SentryListRefusal[] = [];
  let pages = 0;
  let truncated = false;
  const { result, value } = await withDelivery(
    ctx,
    SENTRY_ISSUE_LIST,
    { ...input },
    requestId,
    async () => {
      target = resolveSentryTarget(ctx.config, input.targetLabel);
      const limit = assertListLimit(input.limit);
      const query = listQuery(input.query, target);
      const admitted: SentryIssueDetail[] = [];
      const turnedAway: SentryListRefusal[] = [];
      let cursor: string | undefined;

      // cm:guard the cursor is FOLLOWED, and the bound is SPOKEN. Sentry orders by last seen, so
      // the issues past the last page this walk takes are the same ones on the next tick and the
      // one after — a listing that read page one and reported an ordinary success would be a
      // permanent blind spot nobody could see from the run record.
      while (pages < SENTRY_LIST_MAX_PAGES) {
        const url = sentryOrgIssuesUrl(ctx.config.host, target.organizationSlug, {
          query,
          limit,
          ...(cursor ? { cursor } : {}),
        });
        const out: { link: string | null } = { link: null };
        // cm:guard the partial travels WITH the failure. Everything decided on the pages already
        // walked — every confinement refusal, by name — is local to this callback, so a bare throw
        // deletes it and the operator is left a transport error where there were also six named
        // refusals they have to act on.
        let body: unknown;
        try {
          body = await callSentry(ctx, url, 'GET', undefined, out);
        } catch (err) {
          refused = turnedAway;
          throw new SentryListingFailed(err instanceof Error ? err.message : 'unknown error', {
            pages,
            refused: turnedAway,
          });
        }
        if (!Array.isArray(body)) {
          refused = turnedAway;
          throw new SentryListingFailed(
            `sentry: ${url} answered ${typeof body}, and an issue listing has to be an array`,
            { pages, refused: turnedAway },
          );
        }
        pages += 1;
        for (const raw of body) {
          const issue = projectIssue(raw, '');
          const why = confinementRefusal(issue, target);
          if (why === null) admitted.push(issue);
          else {
            turnedAway.push({
              issueId: issue.id,
              shortId: issue.shortId,
              belongsTo: issue.projectSlug,
              reason: why,
            });
          }
        }
        const next = nextSentryCursor(out.link);
        if (!next) {
          refused = turnedAway;
          return {
            value: admitted,
            // cm:guard the refusals go in the RESPONSE, not only in the return value — the delivery
            // log is where an operator looks, and a confinement that refused forty answers while
            // the row says `ok` with ten issues is a state that lies about itself.
            response: {
              query,
              limit,
              pages,
              truncated,
              admitted: admitted.length,
              refused: turnedAway,
            },
          };
        }
        cursor = next;
      }

      // The bound was reached and Sentry still had more. This is not an error and it is not a
      // success either — it is a named incompleteness, and it is the caller's to report onward.
      truncated = true;
      refused = turnedAway;
      return {
        value: admitted,
        response: {
          query,
          limit,
          pages,
          truncated,
          admitted: admitted.length,
          refused: turnedAway,
        },
      };
    },
  );
  return { result, target, issues: value, refused, pages, truncated };
}

/**
 * The generic door's implementation — `registry.ts:dispatchThrough` reaches this.
 *
 * An unrecognised event is refused BY NAME and leaves a failed delivery row, rather than being
 * absorbed into the nearest operation that would still return.
 */
export async function dispatchSentryOutbound(
  ctx: SentryAdapterContext,
  input: OutboundDispatchInput,
): Promise<OutboundDispatchResult> {
  const payload = (input.payload ?? {}) as SentryIssueRequest;
  if (input.eventName === SENTRY_ISSUE_READ) {
    return (await readSentryIssue(ctx, payload, input.requestId)).result;
  }
  if (input.eventName === SENTRY_ISSUE_SET_STATUS) {
    return (await setSentryIssueStatus(ctx, payload, input.requestId)).result;
  }
  if (input.eventName === SENTRY_ISSUE_LIST) {
    const listInput = (input.payload ?? {}) as SentryListRequest;
    return (await listSentryIssues(ctx, listInput, input.requestId)).result;
  }
  const { result } = await withDelivery(
    ctx,
    input.eventName,
    { ...payload },
    input.requestId,
    async () => {
      throw new Error(
        `sentry: no outbound event named "${input.eventName}" — this adapter implements ${SENTRY_DISPATCH_EVENTS.join(', ')}`,
      );
    },
  );
  return result;
}
