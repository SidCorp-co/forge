import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { projects } from '../../db/schema.js';
import {
  describeInboundDoor,
  effectiveConfig,
  getIntegration,
  grantHolds,
  healthWithInboundDoor,
  inboundDoorState,
  inboundWebhookUrl,
  listBindingsForProject,
  readInboundDoorTraffic,
  resolveApiBaseUrl,
} from '../index.js';
import { type GitLabConfig, gitlabHostOf } from './types.js';

const GITLAB_DELIVERY_LOG =
  "the project's own webhook page on GitLab, under Settings, Webhooks, this hook, Recent events";

/** What `forge_source list` says about each GitLab binding on a project. Contacts GitLab not at all. */
export async function gitlabBindingReports(
  projectId: string,
): Promise<Array<{ provider: string } & Record<string, unknown>>> {
  const decl = getIntegration('gitlab');
  const pairs = (await listBindingsForProject(projectId))
    .filter((p) => p.binding.provider === 'gitlab')
    .sort((a, b) => a.binding.createdAt.getTime() - b.binding.createdAt.getTime());
  if (pairs.length === 0) return [];
  const [project] = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const apiBase = resolveApiBaseUrl();
  const expectedUrl = apiBase && project?.slug ? inboundWebhookUrl(apiBase, project.slug) : null;
  return Promise.all(
    pairs.map(async (pair) => {
      const config = effectiveConfig<GitLabConfig>(pair);
      const traffic = await readInboundDoorTraffic(pair.binding.id);
      const observed = pair.connection.inboundEndpointObserved ?? null;
      const state = inboundDoorState({
        inboundUnprompted: decl?.capabilities.inboundUnprompted ?? false,
        expectedUrl,
        observed,
        traffic,
      });
      const stored = pair.connection.lastHealthStatus ?? null;
      return {
        provider: 'gitlab',
        bindingId: pair.binding.id,
        repository: config.projectPath
          ? `${gitlabHostOf(config)}/${config.projectPath}`
          : config.projectId
            ? `${gitlabHostOf(config)} project ${config.projectId}`
            : null,
        bindingActive: pair.binding.active,
        connectionActive: pair.connection.active,
        agentGranted: grantHolds(decl, pair.binding),
        lastHealthStatus: healthWithInboundDoor(stored, state),
        connectionProbeStatus: stored,
        healthDetail: pair.connection.lastHealthDetail ?? null,
        inboundDoor: state,
        inboundReading: describeInboundDoor({
          state,
          traffic,
          expectedUrl,
          observed,
          providerDeliveryLog: GITLAB_DELIVERY_LOG,
        }),
        expectedWebhookUrl: expectedUrl,
        observedWebhookUrl: observed?.url ?? null,
        inboundDeliveries: traffic.accepted,
        lastInboundDeliveryAt: traffic.lastAcceptedAt?.toISOString() ?? null,
        turnedAwayRecords: traffic.refusalRecords,
        lastRecordedTurnAwayAt: traffic.lastRecordedRefusalAt?.toISOString() ?? null,
        lastTurnedAwayCode: traffic.lastRefusalCode,
      };
    }),
  );
}
