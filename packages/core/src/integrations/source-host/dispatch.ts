import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { integrationBindings } from '../../db/schema.js';
import { recordDelivery } from '../deliveries.js';
import {
  type AdapterContext,
  NonRetryableDispatchError,
  type OutboundDispatchInput,
  type OutboundDispatchResult,
} from '../types.js';
import {
  CHANGE_REQUEST_MERGE_METHODS,
  type ChangeRequestMergeMethod,
  MERGE_EVENT,
  mergeStoredChangeRequest,
} from './merge.js';

interface HostLabel {
  /** The provider name a refusal is prefixed with. */
  provider: string;
  /** How a person names the host. */
  label: string;
  /** The tool carrying what this face does not: opening and reviewing. */
  judgementTool: string;
}

/** Every outbound verb a source host adapter serves. A name not on it is refused naming the set. */
const SERVED_VERBS = [MERGE_EVENT] as const;

function isServedVerb(name: string): name is (typeof SERVED_VERBS)[number] {
  return (SERVED_VERBS as readonly string[]).includes(name);
}

function isMergeMethod(value: unknown): value is ChangeRequestMergeMethod {
  return (
    typeof value === 'string' && (CHANGE_REQUEST_MERGE_METHODS as readonly string[]).includes(value)
  );
}

/**
 * The merge payload, or the sentence saying what is wrong with it. An ABSENT optional field takes
 * the default; a PRESENT invalid one is refused by name — merging is kernel input, where
 * `VISION: kernel-hard-policy-soft` allows no normalisation, and a `method: "sqaush"` read as
 * `merge` lands a shape of history nobody asked for.
 */
export function readMergePayload(
  payload: Record<string, unknown>,
  provider: string,
):
  | { requestedBy: string; expectedHeadSha?: string; method?: ChangeRequestMergeMethod }
  | { refusal: string } {
  const requestedBy = typeof payload.requestedBy === 'string' ? payload.requestedBy : '';
  const out: { requestedBy: string; expectedHeadSha?: string; method?: ChangeRequestMergeMethod } =
    {
      requestedBy,
    };
  if (payload.expectedHeadSha !== undefined) {
    if (
      typeof payload.expectedHeadSha !== 'string' ||
      !/^[0-9a-f]{7,64}$/i.test(payload.expectedHeadSha)
    ) {
      return {
        refusal: `${provider}: \`expectedHeadSha\` must be a git sha — 7 to 64 hex characters — and this call sent ${JSON.stringify(payload.expectedHeadSha)}. It is the head the merge is conditional on, so it is refused rather than dropped.`,
      };
    }
    out.expectedHeadSha = payload.expectedHeadSha;
  }
  if (payload.method !== undefined) {
    if (!isMergeMethod(payload.method)) {
      return {
        refusal: `${provider}: \`${String(payload.method)}\` is not a merge method — the methods are ${CHANGE_REQUEST_MERGE_METHODS.map((m) => `\`${m}\``).join(', ')}, and a host refuses one it lacks. It is refused rather than defaulted, because a mistyped method lands a different shape of history on the base branch.`,
      };
    }
    out.method = payload.method;
  }
  return out;
}

/** Merges on the binding the dispatch was authorised for; a refusal is non-retryable, as it would recur. */
export async function dispatchMergeVerb(
  ctx: AdapterContext,
  input: OutboundDispatchInput,
  host: HostLabel,
): Promise<OutboundDispatchResult> {
  const startedAt = Date.now();
  if (!isServedVerb(input.eventName)) {
    throw new Error(
      `${host.provider}: no outbound verb named \`${input.eventName}\` — this adapter serves ${SERVED_VERBS.map((v) => `\`${v}\``).join(', ')} and nothing else. Opening a change request and reviewing one need judgement and are \`${host.judgementTool}\`'s.`,
    );
  }

  const [live] = await db
    .select({ id: integrationBindings.id })
    .from(integrationBindings)
    .where(and(eq(integrationBindings.id, ctx.bindingId), eq(integrationBindings.active, true)))
    .limit(1);
  if (!live) {
    const message = `${host.provider}: project ${ctx.projectId} has no active ${host.label} binding — binding ${ctx.bindingId} is gone or deactivated, so there is no repository to merge on`;
    await recordDelivery({
      bindingId: null,
      direction: 'outbound',
      eventName: input.eventName,
      payload: { projectId: ctx.projectId, bindingId: ctx.bindingId, refused: message },
      status: 'failed',
    });
    throw new Error(message);
  }

  const payload = (input.payload ?? {}) as Record<string, unknown>;
  const pullRequestId = typeof payload.pullRequestId === 'string' ? payload.pullRequestId : null;
  if (!pullRequestId) {
    throw new Error(
      `${host.provider}: \`${input.eventName}\` needs a payload of the shape { pullRequestId: "<uuid of a repo_pull_requests row>" }`,
    );
  }

  const read = readMergePayload(payload, host.provider);
  if ('refusal' in read) throw new Error(read.refusal);
  const merged = await mergeStoredChangeRequest(
    { pullRequestId, runId: input.runId ?? null, ...read },
    ctx.bindingId,
  );
  if (!merged) {
    throw new Error(
      `${host.provider}: no stored change request ${pullRequestId} — nothing on this project's projection has that id`,
    );
  }
  if (merged.kind === 'refused') throw new NonRetryableDispatchError(merged.detail, merged.reason);
  return {
    deliveryId: merged.deliveryId,
    durationMs: Date.now() - startedAt,
    externalId: merged.commitSha,
  };
}
