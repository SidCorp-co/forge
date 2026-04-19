import { isDeviceConnected } from '../../websocket';
import * as antigravity from '../../antigravity';
import { resolveUser } from './helpers';

/** Handle 'bootstrap' action */
export async function handleBootstrap(input: any, ctx: any): Promise<string> {
  if (!ctx.crossProjectAccess) {
    return 'Error: crossProjectAccess required to bootstrap projects.';
  }
  const docs = ctx.strapi.documents('api::project.project');
  const data = (input.data || {}) as Record<string, any>;
  if (!data.name) return 'Error: data.name required for bootstrap action';

  // 1. Create project
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

  if (data.owner) {
    const ownerDocId = await resolveUser(ctx.strapi, data.owner);
    if (ownerDocId) {
      await docs.update({
        documentId: created.documentId,
        data: { owner: { connect: [ownerDocId] } } as any,
      });
    }
  }

  // 2. Find existing device
  const deviceDocs = ctx.strapi.documents('api::device.device');
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
    // Auto-select first connected device
    const allDevices = await deviceDocs.findMany({ limit: 100 }) as any[];
    device = allDevices.find((d: any) => isDeviceConnected(d.deviceId)) || null;
  }
  if (!device) return 'Error: no device found. Provide data.deviceId or data.deviceDocumentId, or ensure a desktop device is connected.';

  // 3. Connect device to project
  await docs.update({
    documentId: created.documentId,
    data: { devices: { connect: [device.documentId] }, defaultDevice: device.documentId } as any,
  });

  // 4. Optionally create and connect Antigravity project
  let antigravityProjectId: string | null = null;
  if (data.createAntigravity) {
    const agResult = await antigravity.createProject(undefined, undefined, data.agentId);
    antigravityProjectId = agResult?.projectId || agResult?.id || null;
    if (antigravityProjectId) {
      await docs.update({
        documentId: created.documentId,
        data: { antigravityProjectId } as any,
      });
    }
  }

  // 5. Fetch apiKey
  const full = await docs.findOne({ documentId: created.documentId, fields: ['apiKey', 'slug'] }) as any;
  const apiKey = full?.apiKey || null;
  const projectSlug = full?.slug || data.slug;

  // 6. Build MCP config payload
  const serverUrl = ctx.strapi.config.get('server.url', 'http://localhost:1337');

  return JSON.stringify({
    projectDocumentId: created.documentId,
    projectSlug,
    deviceDocumentId: device.documentId,
    deviceId: device.deviceId,
    apiKey,
    antigravityProjectId,
    mcpConfig: {
      mcpServers: {
        forge: {
          type: 'streamable-http',
          url: `${serverUrl}/mcp`,
          headers: { 'x-api-key': apiKey },
        },
      },
    },
    status: 'bootstrapped',
  });
}
