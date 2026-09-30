import {
  applyProjectedEvent,
  type DeliveryContext,
  isProjectedEvent,
} from '../integrations/github/projection-events.js';
import { logger } from '../logger.js';

export interface GitHubAdapterResult {
  actions: number;
}

/**
 * What one delivery carries, whichever event it is. Open on purpose: the events the projection
 * owns are typed where they are read (`integrations/github/projection.ts`), which is the only
 * place that can say what a `check_run` looks like without this file learning what one is.
 */
export type GitHubEventPayload = { action?: string } & Record<string, unknown>;

export async function handleGitHubEvent(
  ctx: DeliveryContext,
  eventType: string,
  payload: GitHubEventPayload,
): Promise<GitHubAdapterResult> {
  if (isProjectedEvent(eventType)) {
    return { actions: await applyProjectedEvent(ctx, eventType, payload) };
  }
  const key = `${eventType}.${payload.action ?? 'unknown'}`;
  logger.info(
    { key, projectId: ctx.projectId },
    'github-adapter: no reader for this event, nothing written — a GitHub issue does not become a Forge issue',
  );
  return { actions: 0 };
}
