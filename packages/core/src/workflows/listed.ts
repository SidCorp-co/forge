// The workflows list as it reads to a viewer: every workflow of the project with its design health
// summarised, read by both doors that list them (REST's `GET /:id/workflows` and the MCP door).

import type { HealthViewer } from './health-ports.js';
import { noHealthSummary, projectHealthAs, summaryOfHealth } from './health-read.js';
import { listWorkflowsAs } from './service.js';

export async function listWorkflowsWithHealthAs(viewer: HealthViewer, projectId: string) {
  const [views, health] = await Promise.all([
    listWorkflowsAs(viewer.userId, projectId),
    projectHealthAs(viewer, projectId),
  ]);
  return views.map((v) => {
    const h = health.get(v.document.id);
    return { ...v, health: h ? summaryOfHealth(h) : noHealthSummary() };
  });
}
