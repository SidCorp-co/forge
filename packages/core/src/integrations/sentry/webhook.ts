/**
 * ISS-1085 slice 4 — the inbound Sentry webhook: the second door onto the intake slice 3 built.
 *
 * A webhook changes the intake's LATENCY and never its capability, which is the issue body's own
 * reason for building the scheduled pull first — if Forge is down a delivery is lost for good,
 * while a pull catches up on the next tick. So nothing here decides whether an error is work:
 * `intake-issue.ts:intakeSentryIssue` does, and the pull calls the same function.
 *
 * What this file owns is everything between the wire and that call — which event was sent, which
 * declared target the delivered issue belongs to, and the record of a delivery that was refused.
 * Every one of those is a REFUSAL BY NAME rather than a guess, because each guess writes to the
 * wrong place: an unserved resource acted on files noise, and a mis-selected target files an error
 * under another stack's project.
 *
 * The signature is verified twice on purpose — `webhooks/inbound-routes.ts` does it to choose the
 * binding, and this file does it again because an adapter reachable from anywhere else must not
 * depend on a caller having checked. Same shape as `github/adapter.ts:handleInbound`.
 */

import { logger } from '../../logger.js';
import { verifyHmacSignature } from '../../webhooks/hmac.js';
import { recordDelivery, updateDelivery } from '../deliveries.js';
import type { AdapterContext, InboundDispatchInput, InboundDispatchResult } from '../types.js';
import { intakeSentryIssue, projectCreatedById, readSentryThresholds } from './intake-issue.js';
import { projectIssue } from './issues.js';
import { resolveSentryTarget, resolveSentryTargets } from './targets.js';
import type { SentryConfig, SentrySecrets } from './types.js';

/** The header Sentry names the delivered object in. Declared on the adapter's capabilities. */
export const SENTRY_RESOURCE_HEADER = 'sentry-hook-resource';
/** The header carrying the HMAC-SHA256 hex digest of the raw body. */
export const SENTRY_SIGNATURE_HEADER = 'sentry-hook-signature';

/**
 * The one resource this handler serves.
 *
 * Sentry also sends `error`, `event_alert`, `metric_alert`, `comment`, `installation`, `seer` and
 * `preprod_artifact`. `error` is one delivery per EVENT, which is a firehose aimed at a gate built
 * to judge issues; the rest describe objects Forge holds no opinion about.
 */
export const SENTRY_SERVED_RESOURCE = 'issue';

/**
 * The issue actions this handler serves, out of `created`, `resolved`, `assigned`, `archived` and
 * `unresolved`.
 */
// cm:guard `resolved` and `archived` are ABSENT deliberately and are not a gap to fill. The loop's resolution contract runs ONE way — a Forge issue closing tells Sentry, never the reverse — and mirroring both directions is how two systems come to contradict each other: a Sentry issue a person resolved after triaging the alert would close a Forge issue whose work nobody did, and closing stamps `merged_at`, which releases every `blocks` dependent as if the work had shipped.
export const SENTRY_SERVED_ACTIONS = ['created', 'unresolved'] as const;

/** What one delivery's envelope carried, before anything is decided about it. */
interface SentryDeliveryEnvelope {
  resource: string | null;
  action: string | null;
  issue: Record<string, unknown> | null;
}

function readEnvelope(input: InboundDispatchInput): SentryDeliveryEnvelope {
  const resource = input.headers[SENTRY_RESOURCE_HEADER] ?? null;
  const payload = (input.payload ?? {}) as Record<string, unknown>;
  const data = (payload.data ?? {}) as Record<string, unknown>;
  const issue = data.issue;
  return {
    resource: typeof resource === 'string' && resource !== '' ? resource : null,
    action: typeof payload.action === 'string' && payload.action !== '' ? payload.action : null,
    issue: issue && typeof issue === 'object' ? (issue as Record<string, unknown>) : null,
  };
}

/**
 * Which declared target this delivered issue belongs to, or why none can be named.
 *
 * A Sentry issue payload carries its PROJECT and no organization, while a target's identity is an
 * organization and a project together. Two targets under different orgs can therefore both declare
 * a project called `web`, and nothing in the delivery tells them apart.
 */
// cm:guard a UNIQUE match or a named refusal, never a pick. The scheduled pull does not face this because it addresses one target's URL itself and confines the answer to it (`listing.ts:confinementRefusal`); a webhook is handed a payload and has only what the payload says. Choosing the first of several matches would file an error, or REOPEN a closed issue, under a project the operator never pointed at this one — silently, with a 200, and only visible later as work filed against the wrong stack.
export function selectSentryTarget(
  config: SentryConfig | null | undefined,
  projectSlug: string | null,
): { label: string } | { refusal: string } {
  const targets = resolveSentryTargets(config);
  const declared = targets.map((t) => t.label).join(', ');
  if (targets.length === 0) {
    return {
      refusal:
        'this binding declares no Sentry targets, so no delivery can be attributed to one — declare a target on the binding before pointing Sentry at this project',
    };
  }

  // cm:guard the candidate set is built WHOLE before uniqueness is judged, and an org-wide target is
  // a candidate for every delivery. Judging the scoped matches first and returning early gave scoped
  // targets a silent precedence they were never granted: a binding declaring `{org A, project web}`
  // beside `{org B, no projectSlug}` answered a delivery naming `web` with A, though B covers the
  // whole of org B and could hold it just as well.
  const scoped = projectSlug === null ? [] : targets.filter((t) => t.projectSlug === projectSlug);
  const orgWide = targets.filter((t) => !t.projectSlug);
  const candidates = [...scoped, ...orgWide];

  const first = candidates[0];
  if (candidates.length === 1 && first) return { label: first.label };
  if (candidates.length > 1) {
    return {
      refusal: `${candidates.length} declared targets could hold this delivery (${candidates.map((t) => t.label).join(', ')}) and a Sentry issue carries no organization, so nothing here can tell them apart — ${
        projectSlug === null
          ? 'this delivery names no project at all'
          : `this delivery names project "${projectSlug}"`
      }. Give every target a distinct projectSlug, or declare exactly one org-wide target and no others — an org-wide target overlaps every scoped one, so keeping one of each leaves this delivery ambiguous.`,
    };
  }

  return projectSlug === null
    ? {
        refusal: `this delivery names no Sentry project, and every target this binding declares is scoped to one (${declared}) — it cannot be confined to any of them`,
      }
    : {
        refusal: `this delivery belongs to Sentry project "${projectSlug}", which no target this binding declares is scoped to and no org-wide target covers — this binding declares: ${declared}`,
      };
}

/** Why this envelope is not one this handler serves, or `null` where it is. */
function unservedReason(envelope: SentryDeliveryEnvelope): string | null {
  if (envelope.resource !== SENTRY_SERVED_RESOURCE) {
    return `this delivery carries sentry-hook-resource "${envelope.resource ?? '(absent)'}", and this handler serves "${SENTRY_SERVED_RESOURCE}" — nothing was done with it`;
  }
  if (
    envelope.action === null ||
    !(SENTRY_SERVED_ACTIONS as readonly string[]).includes(envelope.action)
  ) {
    return `this delivery carries action "${envelope.action ?? '(absent)'}", and this handler serves ${SENTRY_SERVED_ACTIONS.map((a) => `"${a}"`).join(' and ')} — nothing was done with it`;
  }
  if (envelope.issue === null) {
    return 'this delivery carries no `data.issue`, so there is no Sentry issue in it to act on';
  }
  return null;
}

/**
 * One Sentry webhook delivery.
 *
 * Answers rather than throws for anything permanent: a refusal is recorded and returned with
 * `actions: 0`, because a throw becomes a 500 and Sentry retries a delivery whose outcome cannot
 * change. A signature that does not verify still throws — that one is not a delivery this binding
 * has any business answering.
 */
export async function handleSentryWebhook(
  ctx: AdapterContext<SentryConfig, SentrySecrets>,
  input: InboundDispatchInput,
): Promise<InboundDispatchResult> {
  if (!ctx.integrationSecret) {
    throw new Error(
      'sentry: this binding has no integration secret, so no delivery can be verified',
    );
  }
  const signature = input.headers[SENTRY_SIGNATURE_HEADER] ?? null;
  if (!verifyHmacSignature(ctx.integrationSecret, input.rawBody, signature)) {
    throw new Error('sentry: signature verification failed');
  }

  const envelope = readEnvelope(input);
  // cm:why NO `requestId`, and Sentry's own `Request-ID` header is deliberately left in the payload rather than lifted into the key. `deliveries.ts:recordDelivery` inserts `requestId` against a unique index on `(bindingId, requestId)` with no `onConflict` — priced at `docs/proposals/a-request-keyed-outbound-delivery-cannot-be-retried.md` — and Sentry RE-DELIVERS a hook that failed, carrying the same id, so keying the row on it would make the retry die on that index and answer 500. The column meant to make a delivery traceable would be what turns a recoverable failure into a permanent one. Idempotency of the ACTION is already held by the unique `(project_id, source, external_id)` index and by the lookup-first path in `intake-issue.ts`.
  const deliveryId = await recordDelivery({
    bindingId: ctx.bindingId,
    direction: 'inbound',
    eventName: `${envelope.resource ?? 'unknown'}.${envelope.action ?? 'unknown'}`,
    payload: input.payload,
    status: 'pending',
  });

  // cm:guard every exit below this line goes through `refuse` or `acted`, so a delivery row never stays `pending`. A row left pending reads to the connection drawer as a call still in flight, which for an inbound delivery that was answered and closed is a state that lies.
  const refuse = async (reason: string): Promise<InboundDispatchResult> => {
    await updateDelivery(deliveryId, {
      status: 'failed',
      errorMessage: reason,
      completedAt: new Date(),
    });
    logger.info(
      { projectId: ctx.projectId, bindingId: ctx.bindingId, deliveryId, reason },
      'sentry webhook: delivery refused by name',
    );
    return { deliveryId, actions: 0, refusal: reason };
  };

  // cm:guard EVERY path after the insert closes the row, including a throw. A delivery row left
  // `pending` reads to the connection drawer as a call still in flight — for an inbound delivery
  // that was answered and closed, that is a state that lies, and it is the shape a `catch` that only
  // wrapped the happy path leaves behind. A retryable failure is recorded and RETHROWN so the router
  // answers 500 and Sentry re-delivers; only a permanent refusal answers 200.
  try {
    const unserved = unservedReason(envelope);
    if (unserved) return await refuse(unserved);

    const issue = projectIssue(envelope.issue, '');
    const selected = selectSentryTarget(ctx.config, issue.projectSlug);
    if ('refusal' in selected) return await refuse(selected.refusal);

    const createdById = await projectCreatedById(ctx.projectId);
    if (!createdById) {
      return await refuse(
        'this project has no creator to file Sentry issues as, so the delivery could not be acted on',
      );
    }

    // cm:guard `resolveSentryTarget` THROWS for a target declaring no organizationSlug, which is a
    // configuration a redelivery cannot fix. Caught and turned into a named refusal here rather than
    // left to propagate: a 500 would have Sentry retry the same delivery against the same broken
    // declaration until it gives up, and the operator would see a failing integration rather than
    // the sentence naming the target they have to edit.
    let target: ReturnType<typeof resolveSentryTarget>;
    try {
      target = resolveSentryTarget(ctx.config, selected.label);
    } catch (err) {
      return await refuse(
        err instanceof Error ? err.message : 'the selected target could not be resolved',
      );
    }

    const outcome = await intakeSentryIssue(issue, {
      projectId: ctx.projectId,
      createdById,
      thresholds: await readSentryThresholds(),
      target,
    });

    if (outcome.kind === 'refused') return await refuse(outcome.reason);

    await updateDelivery(deliveryId, { status: 'ok', completedAt: new Date() });
    logger.info(
      { projectId: ctx.projectId, deliveryId, shortId: issue.shortId, outcome: outcome.kind },
      'sentry webhook: delivery acted on',
    );
    return { deliveryId, actions: 1 };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    await updateDelivery(deliveryId, {
      status: 'failed',
      errorMessage: `this delivery failed part way: ${message}. Some of its writes may already have committed — the issue's own comments and metadata are the record of what did.`,
      completedAt: new Date(),
    });
    throw err;
  }
}
