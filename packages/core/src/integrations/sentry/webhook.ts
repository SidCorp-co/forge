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
  const deliveryId = await recordDelivery({
    bindingId: ctx.bindingId,
    direction: 'inbound',
    eventName: `${envelope.resource ?? 'unknown'}.${envelope.action ?? 'unknown'}`,
    payload: input.payload,
    status: 'pending',
  });

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
