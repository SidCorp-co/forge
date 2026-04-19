import * as antigravity from '../../antigravity';
import { resolveTargetProject } from './helpers';

/** Handle 'antigravity_list' action */
export async function handleAntigravityList(): Promise<string> {
  const result = await antigravity.listProjects();
  return JSON.stringify(result);
}

/** Handle 'antigravity_list_agents' action */
export async function handleAntigravityListAgents(): Promise<string> {
  const agents = await antigravity.listAgents();
  return JSON.stringify(agents);
}

/** Handle 'antigravity_create' action */
export async function handleAntigravityCreate(input: any, ctx: any): Promise<string> {
  if (!ctx.crossProjectAccess) {
    return 'Error: crossProjectAccess required to create Antigravity projects.';
  }
  const data = (input.data || {}) as Record<string, any>;
  const configBuffer = data.configFile ? Buffer.from(data.configFile, 'base64') : undefined;
  const result = await antigravity.createProject(configBuffer, configBuffer ? 'config.json' : undefined, data.agentId);
  return JSON.stringify(result);
}

/** Handle 'antigravity_connect' action */
export async function handleAntigravityConnect(input: any, ctx: any): Promise<string> {
  const docs = ctx.strapi.documents('api::project.project');
  let docId = input.documentId as string | undefined;
  const slug = (input.slug || input.targetProjectSlug) as string | undefined;
  if (!docId && slug) {
    docId = (await resolveTargetProject(ctx.strapi, slug)) || undefined;
    if (!docId) return `Error: project with slug "${slug}" not found`;
  }
  if (!docId) docId = ctx.projectDocumentId;

  if (docId !== ctx.projectDocumentId && !ctx.crossProjectAccess) {
    return 'Error: crossProjectAccess required to connect Antigravity to other projects.';
  }

  const data = (input.data || {}) as Record<string, any>;
  if (!data.antigravityProjectId) return 'Error: data.antigravityProjectId required for antigravity_connect action';

  await docs.update({
    documentId: docId,
    data: { antigravityProjectId: data.antigravityProjectId } as any,
  });

  return JSON.stringify({
    projectDocumentId: docId,
    antigravityProjectId: data.antigravityProjectId,
    status: 'connected',
  });
}

/** Handle 'antigravity_exclude' / 'antigravity_include' actions */
export async function handleAntigravityExcludeInclude(input: any, ctx: any, action: string): Promise<string> {
  if (!ctx.crossProjectAccess) {
    return 'Error: crossProjectAccess required to exclude/include Antigravity runners.';
  }
  const data = (input.data || {}) as Record<string, any>;
  const runnerId = data.runnerId || input.documentId as string;
  if (!runnerId) return 'Error: data.runnerId or documentId required for antigravity_exclude/include action';

  const runnerDocs = ctx.strapi.documents('api::antigravity-runner.antigravity-runner' as any);
  const excluded = action === 'antigravity_exclude';
  const runner = await runnerDocs.update({
    documentId: runnerId,
    data: { excluded },
  });
  if (!runner) return `Error: runner "${runnerId}" not found`;

  // Proactively pause/resume affected projects
  const projectDocs = ctx.strapi.documents('api::project.project' as any);
  const { checkAntigravityReady, pauseProjectAntigravity, clearProjectAntigravityError } = await import('../../antigravity-runner-pool');
  const allProjects: any[] = await projectDocs.findMany({
    fields: ['agentConfig'],
    populate: { antigravityRunners: { fields: ['documentId'] } },
    limit: 200,
  });
  for (const project of allProjects) {
    const inPool = (project.antigravityRunners || []).some((r: any) => r.documentId === runnerId);
    if (!inPool) continue;
    const readiness = await checkAntigravityReady(project.documentId);
    if (excluded && !readiness.ready) {
      await pauseProjectAntigravity(project.documentId, readiness.error || 'Runner excluded from pool');
    } else if (!excluded && readiness.ready && project.agentConfig?.antigravityError) {
      await clearProjectAntigravityError(project.documentId);
      try {
        const { dispatchNextForProject } = await import('../../pipeline-orchestrator');
        await dispatchNextForProject(ctx.strapi, project.documentId, 'antigravity');
      } catch { /* ignore */ }
    }
  }

  return JSON.stringify({
    runnerId: runner.documentId,
    runnerName: (runner as any).name,
    excluded,
    status: (runner as any).status,
  });
}
