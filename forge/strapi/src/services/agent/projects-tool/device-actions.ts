import { isDeviceConnected } from '../../websocket';
import { resolveTargetProject } from './helpers';

/** Handle 'get_api_key' action */
export async function handleGetApiKey(input: any, ctx: any): Promise<string> {
  const docs = ctx.strapi.documents('api::project.project');
  let docId = input.documentId as string | undefined;
  const slug = (input.slug || input.targetProjectSlug) as string | undefined;
  if (!docId && slug) {
    docId = (await resolveTargetProject(ctx.strapi, slug)) || undefined;
    if (!docId) return `Error: project with slug "${slug}" not found`;
  }
  if (!docId) docId = ctx.projectDocumentId;

  if (docId !== ctx.projectDocumentId && !ctx.crossProjectAccess) {
    return 'Error: crossProjectAccess required to get API key for other projects.';
  }

  const project = await docs.findOne({ documentId: docId, fields: ['name', 'slug', 'apiKey'] }) as any;
  if (!project) return 'Error: Project not found';

  return JSON.stringify({
    documentId: project.documentId,
    name: project.name,
    slug: project.slug,
    apiKey: project.apiKey,
  });
}

/** Handle 'register_device' action */
export async function handleRegisterDevice(input: any, ctx: any): Promise<string> {
  const docs = ctx.strapi.documents('api::project.project');
  let projectDocId = input.documentId as string | undefined;
  const slug = (input.slug || input.targetProjectSlug) as string | undefined;
  if (!projectDocId && slug) {
    projectDocId = (await resolveTargetProject(ctx.strapi, slug)) || undefined;
    if (!projectDocId) return `Error: project with slug "${slug}" not found`;
  }
  if (!projectDocId) projectDocId = ctx.projectDocumentId;

  if (projectDocId !== ctx.projectDocumentId && !ctx.crossProjectAccess) {
    return 'Error: crossProjectAccess required to register devices on other projects.';
  }

  const data = (input.data || {}) as Record<string, any>;
  const deviceDocs = ctx.strapi.documents('api::device.device');

  // Look up existing device by deviceDocumentId or deviceId
  let device: any;
  if (data.deviceDocumentId) {
    device = await deviceDocs.findOne({ documentId: data.deviceDocumentId });
  } else if (data.deviceId) {
    const found = await deviceDocs.findMany({
      filters: { deviceId: { $eq: data.deviceId } },
      limit: 1,
    });
    device = found[0] || null;
  } else {
    return 'Error: data.deviceId or data.deviceDocumentId required. Use list_devices action to see available devices.';
  }

  if (!device) return 'Error: device not found. Use list_devices to see available devices.';

  // Connect device to project
  const project = await docs.findOne({
    documentId: projectDocId,
    fields: ['slug', 'apiKey'],
    populate: { devices: { fields: ['documentId'] }, defaultDevice: { fields: ['documentId'] } },
  }) as any;
  if (!project) return 'Error: Project not found';

  const alreadyConnected = (project.devices || []).some((d: any) => d.documentId === device.documentId);
  const updateData: Record<string, any> = {};
  if (!alreadyConnected) updateData.devices = { connect: [device.documentId] };
  if (!project.defaultDevice) updateData.defaultDevice = device.documentId;
  if (Object.keys(updateData).length) {
    await docs.update({ documentId: projectDocId, data: updateData as any });
  }

  return JSON.stringify({
    projectDocumentId: projectDocId,
    projectSlug: project.slug,
    deviceDocumentId: device.documentId,
    deviceId: device.deviceId,
    apiKey: project.apiKey,
  });
}

/** Handle 'list_devices' action */
export async function handleListDevices(input: any, ctx: any): Promise<string> {
  const deviceDocs = ctx.strapi.documents('api::device.device');
  const devices = await deviceDocs.findMany({
    populate: { user: { fields: ['username'] } },
    limit: 100,
  }) as any[];

  return JSON.stringify(
    devices.map((d: any) => ({
      documentId: d.documentId,
      deviceId: d.deviceId,
      name: d.name,
      lastSeen: d.lastSeen || null,
      connected: isDeviceConnected(d.deviceId),
      user: d.user ? { username: d.user.username } : null,
    })),
  );
}
