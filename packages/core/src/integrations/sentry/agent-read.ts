/**
 * The read an agent working a project makes of that project's Sentry, server-side.
 *
 * `listSentryIssues` and `readSentryIssue` were reachable only from the `sentry_pull` schedule,
 * which is a thresholded intake that FILES work. This is the other question — what is erroring
 * right now — and it answers it without a threshold, without creating anything, and without the
 * caller holding a Sentry credential: the binding is resolved here and the token never leaves core.
 */

import { scrubLogText } from '@forge/observability';
import { grantHolds, notGrantedMessage } from '../agent-access.js';
import { getIntegration } from '../registry.js';
import {
  type BindingWithConnection,
  buildContextFromBinding,
  listBindingsForProject,
} from '../store.js';
import { listSentryIssues, readSentryIssue, type SentryAdapterContext } from './issues.js';
import { type SentryIssueListing, SentryListingFailed, type SentryListRefusal } from './listing.js';
import { SentryRefusal } from './refusals.js';
import { resolveSentryTargets } from './targets.js';
import type { SentryConfig, SentryIssueDetail, SentrySecrets } from './types.js';

/** Which Sentry search term each caller-facing filter becomes. */
const FILTER_TERMS = {
  release: 'release',
  path: 'http.path',
  method: 'http.method',
  errorCode: 'error.code',
  requestId: 'request.id',
} as const;

export type SentryAgentFilter = keyof typeof FILTER_TERMS;

export const SENTRY_AGENT_STATUSES = ['unresolved', 'resolved', 'ignored', 'any'] as const;
export type SentryAgentStatus = (typeof SENTRY_AGENT_STATUSES)[number];

export interface SentryAgentReadRequest {
  projectId: string;
  /** Which declared target to read, where the binding declares more than one. */
  target?: string;
}

export interface SentryAgentListRequest extends SentryAgentReadRequest {
  status?: SentryAgentStatus;
  release?: string;
  path?: string;
  method?: string;
  errorCode?: string;
  requestId?: string;
  /** Sentry's own relative window: `1h`, `24h`, `7d`. */
  window?: string;
  /** Extra Sentry search syntax, added to the terms above rather than replacing them. */
  query?: string;
  limit?: number;
}

export interface SentryAgentGetRequest extends SentryAgentReadRequest {
  issueId: string;
}

export interface SentryAgentListing {
  target: string;
  organizationSlug: string;
  projectSlug: string | null;
  /** The search Sentry was actually asked, so a surprising answer can be read back to its question. */
  query: string;
  window: string | null;
  issues: SentryIssueDetail[];
  /** Answers Sentry gave that this target is not scoped to, named one by one. */
  refused: SentryListRefusal[];
  pages: number;
  /** True where Sentry still had more and the adapter stopped at its own page bound. */
  truncated: boolean;
}

/** A value as Sentry's search syntax takes it: quoted, with quotes and backslashes escaped. */
function term(key: string, value: string): string {
  return `${key}:"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function sentryAgentQuery(input: SentryAgentListRequest): string {
  const parts: string[] = [];
  const status = input.status ?? 'unresolved';
  if (status !== 'any') parts.push(`is:${status}`);
  for (const [field, key] of Object.entries(FILTER_TERMS)) {
    const value = input[field as SentryAgentFilter];
    if (typeof value === 'string' && value.trim() !== '') parts.push(term(key, value.trim()));
  }
  const extra = input.query?.trim();
  if (extra) parts.push(extra);
  return parts.join(' ');
}

/**
 * The Sentry binding this project's agents read through, or the refusal naming which wall was hit.
 *
 * Four walls, four answers, because each sends whoever met it somewhere different: nobody bound
 * Sentry, the binding is switched off, the credential behind it is switched off for every project
 * sharing it, and it works but no agent here may use it.
 */
export async function resolveGrantedSentryBinding(
  projectId: string,
): Promise<BindingWithConnection> {
  const pairs = (await listBindingsForProject(projectId))
    .filter((r) => r.binding.provider === 'sentry')
    .sort((a, b) => a.binding.createdAt.getTime() - b.binding.createdAt.getTime());

  const first = pairs[0];
  if (!first) {
    throw new SentryRefusal(
      'no_binding',
      'no Sentry binding on this project — connect Sentry and bind it under Settings → Integrations. Nothing was asked of Sentry.',
    );
  }
  const usable = pairs.find((r) => r.binding.active && r.connection.active);
  if (!usable) {
    const dead = pairs.find((r) => !r.binding.active) ?? first;
    if (!dead.binding.active) {
      throw new SentryRefusal(
        'binding_disabled',
        `this project's Sentry binding exists and is switched off for this project — re-enable it under Settings → Integrations. Nothing was asked of Sentry.`,
        { bindingId: dead.binding.id },
      );
    }
    throw new SentryRefusal(
      'connection_disabled',
      `this project's Sentry binding exists and its Sentry credential is switched off for every project sharing it — re-enable the connection under Settings → Integrations. Nothing was asked of Sentry.`,
      { bindingId: dead.binding.id },
    );
  }
  if (!grantHolds(getIntegration('sentry'), usable.binding)) {
    throw new SentryRefusal('not_granted', notGrantedMessage('sentry', usable.binding.id), {
      bindingId: usable.binding.id,
    });
  }
  return usable;
}

/**
 * Take this binding's credentials out of third-party text, whichever way the call ended.
 *
 * Both tokens, because during a rotation the failing call may have been the retry. Sentry's text
 * is third-party input on BOTH paths: an error quotes the request that failed, and an issue title
 * or culprit is whatever the product put in the event it captured.
 */
function scrubberFor(ctx: SentryAdapterContext): (text: string) => string {
  const secrets = [ctx.secrets?.authToken, ctx.secrets?.previousAuthToken].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  return (text: string) => scrubLogText(text, secrets);
}

/** The free text Sentry filled, with this binding's credentials taken out of it. */
function scrubIssue(issue: SentryIssueDetail, clean: (text: string) => string): SentryIssueDetail {
  const text = (value: string | null) => (value === null ? null : clean(value));
  return {
    ...issue,
    title: text(issue.title),
    culprit: text(issue.culprit),
    metadataValue: text(issue.metadataValue),
    permalink: text(issue.permalink),
  };
}

function rethrowScrubbed(err: unknown, ctx: SentryAdapterContext, bindingId: string): never {
  const clean = scrubberFor(ctx);
  if (err instanceof SentryListingFailed) {
    const inner = err.refusal;
    throw new SentryRefusal(inner?.reason ?? 'sentry_unreachable', clean(err.message), {
      httpStatus: inner?.httpStatus ?? null,
      bindingId,
    });
  }
  if (err instanceof SentryRefusal) {
    throw new SentryRefusal(err.reason, clean(err.message), {
      httpStatus: err.httpStatus,
      bindingId,
    });
  }
  throw new SentryRefusal(
    'sentry_unreachable',
    clean(err instanceof Error ? err.message : 'unknown error'),
    { bindingId },
  );
}

/** Refuse before the call where the binding declares nothing to address. */
function assertHasTargets(ctx: SentryAdapterContext, bindingId: string): void {
  if (resolveSentryTargets(ctx.config).length === 0) {
    throw new SentryRefusal(
      'no_targets',
      `binding ${bindingId} declares no Sentry targets, so no Sentry project can be named — give it an organization and project under Settings → Integrations.`,
      { bindingId },
    );
  }
}

/**
 * Sentry answered, and this target is scoped to none of it.
 *
 * `issues: []` beside a populated confinement list is the one shape that breaks the promise the
 * whole door rests on — that an empty listing means Sentry reported nothing. It also means the
 * `project:` term the query carries did not bind, which is worth saying rather than reading as a
 * quiet night.
 */
function assertNotAllConfinedOut(listing: SentryIssueListing, bindingId: string): void {
  if (listing.issues.length > 0 || listing.refused.length === 0) return;
  const named = listing.refused
    .slice(0, 10)
    .map((one) => one.shortId ?? one.issueId)
    .join(', ');
  const more = listing.refused.length > 10 ? `, and ${listing.refused.length - 10} more` : '';
  throw new SentryRefusal(
    'confined_out',
    `sentry: Sentry answered with ${listing.refused.length} issue(s) and target "${listing.target.label}" is scoped to none of them — ${named}${more}. This target is confined to project ${listing.target.projectSlug}, so this is not an empty error stream.`,
    { bindingId },
  );
}

export async function readProjectSentryIssues(
  input: SentryAgentListRequest,
): Promise<SentryAgentListing> {
  const pair = await resolveGrantedSentryBinding(input.projectId);
  const ctx = buildContextFromBinding<SentryConfig, SentrySecrets>(pair);
  assertHasTargets(ctx, pair.binding.id);
  try {
    const listing = await listSentryIssues(ctx, {
      ...(input.target ? { targetLabel: input.target } : {}),
      query: sentryAgentQuery(input),
      ...(input.window ? { statsPeriod: input.window } : {}),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
    assertNotAllConfinedOut(listing, pair.binding.id);
    const clean = scrubberFor(ctx);
    return {
      target: listing.target.label,
      organizationSlug: listing.target.organizationSlug,
      projectSlug: listing.target.projectSlug ?? null,
      query: listing.query,
      window: input.window ?? null,
      issues: listing.issues.map((issue) => scrubIssue(issue, clean)),
      refused: listing.refused.map((one) => ({ ...one, reason: clean(one.reason) })),
      pages: listing.pages,
      truncated: listing.truncated,
    };
  } catch (err) {
    rethrowScrubbed(err, ctx, pair.binding.id);
  }
}

export async function readProjectSentryIssue(
  input: SentryAgentGetRequest,
): Promise<SentryIssueDetail> {
  const pair = await resolveGrantedSentryBinding(input.projectId);
  const ctx = buildContextFromBinding<SentryConfig, SentrySecrets>(pair);
  assertHasTargets(ctx, pair.binding.id);
  try {
    const call = await readSentryIssue(ctx, {
      issueId: input.issueId,
      ...(input.target ? { targetLabel: input.target } : {}),
    });
    return scrubIssue(call.issue, scrubberFor(ctx));
  } catch (err) {
    rethrowScrubbed(err, ctx, pair.binding.id);
  }
}
