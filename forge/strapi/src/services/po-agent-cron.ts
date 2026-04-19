import type { Core } from '@strapi/strapi';
import { sendToDevice, isDeviceConnected } from './websocket';
import { findAvailableDevice, clearDeviceAllocation } from './device-pool';
import { resolveRepoPath } from './resolve-repo-path';

const AGENT_UID = 'api::agent.agent' as any;
const SESSION_UID = 'api::agent-session.agent-session' as any;

function shouldRunToday(schedule: string): boolean {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon, ...
  const date = now.getUTCDate();

  switch (schedule) {
    case 'weekly':
      return day === 1; // Every Monday
    case 'biweekly':
      // Every other Monday (weeks where ISO week number is even)
      if (day !== 1) return false;
      const startOfYear = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
      const weekNum = Math.ceil(((now.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getUTCDay() + 1) / 7);
      return weekNum % 2 === 0;
    case 'monthly':
      return date === 1; // First day of month
    default:
      return false;
  }
}

export async function triggerScheduledPoReviews(strapi: Core.Strapi) {
  // Query all enabled agents with a schedule, populate project (with defaultDevice) and definition
  const agents = await strapi.documents(AGENT_UID).findMany({
    filters: { enabled: true, schedule: { $ne: 'off' } },
    populate: { project: { populate: ['defaultDevice'] }, definition: true },
    limit: 100,
  });

  for (const agent of agents) {
    const project = (agent as any).project;
    if (!project) continue;
    if (!shouldRunToday((agent as any).schedule)) continue;

    // Try pool allocation first, fall back to defaultDevice
    const allocated = await findAvailableDevice(project.documentId);
    if (allocated) clearDeviceAllocation(allocated.deviceId);
    let deviceId: string | null = allocated?.deviceId ?? null;
    if (!deviceId) {
      deviceId = project.defaultDevice?.deviceId || null;
    }
    if (!deviceId || !isDeviceConnected(deviceId)) {
      strapi.log.debug(`PO Agent cron: no device connected for project "${project.name}", skipping`);
      continue;
    }

    strapi.log.info(`PO Agent cron: triggering review for project "${project.name}" (${project.slug}), agent "${(agent as any).name}"`);

    const agentName = (agent as any).name || 'Agent';
    const agentType = (agent as any).type || 'unknown';
    const rp = await resolveRepoPath(strapi, project.slug, deviceId, undefined, project.repoPath);
    const session = await strapi.documents(SESSION_UID).create({
      data: {
        title: `${agentName} Review (Scheduled)`,
        status: 'running',
        messages: [{ role: 'user', content: `${agentName}: Scheduled Review`, timestamp: Date.now() }],
        project: project.documentId,
        repoPath: rp,
        metadata: { type: agentType, scheduled: true },
      } as any,
    });

    if (deviceId) clearDeviceAllocation(deviceId);

    // Determine the WebSocket event and prompt based on agent type
    const wsEvent = agentType === 'sprint-planner' ? 'agent:start' : 'agent:review';
    sendToDevice(deviceId, wsEvent, {
      sessionId: session.documentId,
      repoPath: rp,
      projectSlug: project.slug,
      agentConfig: agent,
      // Sprint planner uses a skill prompt instead of the review flow
      ...(agentType === 'sprint-planner' ? { prompt: '/forge-sprint-plan' } : {}),
    });
  }
}
