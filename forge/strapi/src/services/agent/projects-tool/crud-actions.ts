import { resolveTargetProject, resolveUser } from './helpers';

/** Handle 'list' action */
export async function handleList(input: any, ctx: any): Promise<string> {
  const docs = ctx.strapi.documents('api::project.project');
  const projects = await docs.findMany({
    fields: ['documentId', 'name', 'slug', 'description', 'crossProjectAccess', 'projectMeta', 'baseBranch'],
    populate: {
      owner: { fields: ['username', 'email'] },
      members: { fields: ['username', 'email'] },
    },
    limit: 100,
  });
  return JSON.stringify(
    projects.map((p: any) => ({
      documentId: p.documentId,
      name: p.name,
      slug: p.slug,
      description: p.description,
      crossProjectAccess: p.crossProjectAccess || false,
      projectMeta: p.projectMeta || {},
      baseBranch: p.baseBranch || 'main',
      owner: p.owner ? { username: p.owner.username, email: p.owner.email } : null,
      members: (p.members || []).map((m: any) => ({ username: m.username, email: m.email })),
    })),
  );
}

/** Handle 'get' action */
export async function handleGet(input: any, ctx: any): Promise<string> {
  const docs = ctx.strapi.documents('api::project.project');
  let docId = input.documentId as string | undefined;

  // Resolve by slug if provided
  const slug = (input.slug || input.targetProjectSlug) as string | undefined;
  if (!docId && slug) {
    docId = (await resolveTargetProject(ctx.strapi, slug)) || undefined;
    if (!docId) return `Error: project with slug "${slug}" not found`;
  }
  if (!docId) return 'Error: documentId or slug required for get action';

  const project = await docs.findOne({
    documentId: docId,
    populate: {
      owner: { fields: ['username', 'email'] },
      members: { fields: ['username', 'email'] },
      devices: { fields: ['name', 'deviceId'] },
    },
  }) as any;
  if (!project) return 'Error: Project not found';

  return JSON.stringify({
    documentId: project.documentId,
    name: project.name,
    slug: project.slug,
    description: project.description,
    crossProjectAccess: project.crossProjectAccess || false,
    projectMeta: project.projectMeta || {},
    baseBranch: project.baseBranch || 'main',
    productionBranch: project.productionBranch || null,
    repoPath: project.repoPath || null,
    agentConfig: project.agentConfig || null,
    pipelineConfig: project.agentConfig?.pipelineConfig || null,
    previewDeploy: project.previewDeploy || null,
    owner: project.owner ? { username: project.owner.username, email: project.owner.email } : null,
    members: (project.members || []).map((m: any) => ({ username: m.username, email: m.email })),
    devices: (project.devices || []).map((d: any) => ({ name: d.name, deviceId: d.deviceId })),
  });
}

/** Handle 'create' action */
export async function handleCreate(input: any, ctx: any): Promise<string> {
  if (!ctx.crossProjectAccess) {
    return 'Error: crossProjectAccess required to create projects.';
  }
  const docs = ctx.strapi.documents('api::project.project');
  const data = input.data as Record<string, any>;
  if (!data?.name) return 'Error: data.name required for create action';

  const created = await docs.create({
    data: {
      name: data.name,
      slug: data.slug,
      description: data.description,
      crossProjectAccess: data.crossProjectAccess || false,
      projectMeta: data.projectMeta || {},
      agentConfig: data.agentConfig || null,
    },
  });

  // Set owner relation after creation (same pattern as REST controller)
  if (data.owner) {
    const ownerDocId = await resolveUser(ctx.strapi, data.owner);
    if (!ownerDocId) return `Error: user "${data.owner}" not found`;
    await docs.update({
      documentId: created.documentId,
      data: { owner: { connect: [ownerDocId] } } as any,
    });
  }

  // Re-fetch to get the auto-generated apiKey from lifecycle hook
  const full = await docs.findOne({ documentId: created.documentId, fields: ['apiKey'] }) as any;

  return JSON.stringify({
    documentId: created.documentId,
    name: created.name,
    slug: (created as any).slug,
    apiKey: full?.apiKey || null,
    status: 'created',
  });
}

/** Handle 'update' action */
export async function handleUpdate(input: any, ctx: any): Promise<string> {
  const docs = ctx.strapi.documents('api::project.project');
  const docId = input.documentId as string;
  if (!docId) return 'Error: documentId required for update action';
  // Allow self-project updates; require crossProjectAccess for other projects
  if (docId !== ctx.projectDocumentId && !ctx.crossProjectAccess) {
    return 'Error: crossProjectAccess required to update other projects.';
  }
  const data = input.data as Record<string, any>;
  if (!data) return 'Error: data required for update action';

  const updateData: Record<string, any> = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.description !== undefined) updateData.description = data.description;
  if (data.crossProjectAccess !== undefined) updateData.crossProjectAccess = data.crossProjectAccess;
  if (data.projectMeta !== undefined) updateData.projectMeta = data.projectMeta;

  // Handle owner relation
  if (data.owner !== undefined) {
    if (data.owner === null || data.owner === '') {
      updateData.owner = { set: [] };
    } else {
      const ownerDocId = await resolveUser(ctx.strapi, data.owner);
      if (!ownerDocId) return `Error: user "${data.owner}" not found`;
      updateData.owner = { connect: [ownerDocId] };
    }
  }

  // Handle members relation
  if (data.members !== undefined) {
    if (!Array.isArray(data.members)) return 'Error: members must be an array of user documentIds or usernames';
    const memberDocIds: string[] = [];
    for (const identifier of data.members) {
      const memberDocId = await resolveUser(ctx.strapi, identifier);
      if (!memberDocId) return `Error: user "${identifier}" not found`;
      memberDocIds.push(memberDocId);
    }
    updateData.members = { set: memberDocIds };
  }

  const updated = await docs.update({ documentId: docId, data: updateData });
  return JSON.stringify({ documentId: updated.documentId, status: 'updated' });
}
