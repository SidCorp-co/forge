import { factories } from '@strapi/strapi';
import { sendToDevice, isDeviceConnected } from '../../../services/websocket';

const UID = 'api::device.device' as any;
const SESSION_UID = 'api::agent-session.agent-session' as any;

/** In-memory map tracking device-init progress: key = `${deviceId}:${projectSlug}` */
const initStatusMap = new Map<string, {
  status: 'running' | 'completed' | 'failed';
  steps: { create: string; clone: string; skills: string };
  sessionId: string;
  targetPath: string;
}>();

export default factories.createCoreController(UID, ({ strapi }) => ({
  // Filter to current user's devices via document service
  // (avoids Strapi REST validation error on users-permissions relations)
  async find(ctx) {
    if (ctx.state.user) {
      const all: any[] = await strapi.documents(UID).findMany({
        populate: ['user'],
      });
      const userDevices = all.filter((d: any) => d.user?.id === ctx.state.user.id);
      return { data: userDevices, meta: { pagination: { total: userDevices.length } } };
    }
    return super.find(ctx);
  },

  // Upsert device by deviceId
  async register(ctx) {
    const { deviceId, name } = ctx.request.body as any;
    if (!deviceId || !name) {
      ctx.status = 400;
      return { error: 'deviceId and name are required' };
    }

    const existing = await strapi.documents(UID).findMany({
      filters: { deviceId: { $eq: deviceId } },
      populate: ['user'],
      limit: 1,
    });

    const now = new Date().toISOString();

    if (existing[0]) {
      const data: Record<string, any> = {
        lastSeen: now,
        user: ctx.state.user?.documentId || existing[0].user?.documentId,
      };
      // Only set name on first registration (when empty); preserve user renames from web
      if (!existing[0].name) data.name = name;

      const device = await strapi.documents(UID).update({
        documentId: existing[0].documentId,
        data: data as any,
      });
      return { data: device };
    }

    const device = await strapi.documents(UID).create({
      data: {
        deviceId,
        name,
        lastSeen: now,
        user: ctx.state.user?.documentId,
      } as any,
    });
    ctx.status = 201;
    return { data: device };
  },

  // Set projectsRoot by deviceId (used by desktop app)
  async setProjectsRoot(ctx) {
    const { deviceId, projectsRoot } = ctx.request.body as any;
    if (!deviceId) {
      ctx.status = 400;
      return { error: 'deviceId is required' };
    }

    const existing = await strapi.documents(UID).findMany({
      filters: { deviceId: { $eq: deviceId } },
      limit: 1,
    });
    if (!existing[0]) {
      ctx.status = 404;
      return { error: 'Device not found' };
    }

    const device = await strapi.documents(UID).update({
      documentId: existing[0].documentId,
      data: { projectsRoot: projectsRoot || null } as any,
    });
    return { data: device };
  },

  // Update device fields (name, projectsRoot)
  async updateDevice(ctx) {
    const { documentId } = ctx.params;
    const body = (ctx.request.body as any)?.data || ctx.request.body;
    const { name, projectsRoot, disabledUntil } = body;

    const existing: any = await strapi.documents(UID).findOne({ documentId });
    if (!existing) {
      ctx.status = 404;
      return { error: 'Device not found' };
    }

    const updates: Record<string, any> = {};
    if (name !== undefined) updates.name = name;
    if (projectsRoot !== undefined) updates.projectsRoot = projectsRoot;
    if (disabledUntil !== undefined) updates.disabledUntil = disabledUntil;

    const device = await strapi.documents(UID).update({
      documentId,
      data: updates as any,
    });
    return { data: device };
  },

  // Set a device's repo path for a specific project
  async setProjectPath(ctx) {
    const { deviceId, projectSlug, repoPath } = ctx.request.body as any;
    if (!deviceId || !projectSlug) {
      ctx.status = 400;
      return { error: 'deviceId and projectSlug are required' };
    }

    const existing = await strapi.documents(UID).findMany({
      filters: { deviceId: { $eq: deviceId } },
      limit: 1,
    });
    if (!existing[0]) {
      ctx.status = 404;
      return { error: 'Device not found' };
    }

    const paths = { ...(existing[0].projectPaths || {}) } as Record<string, string>;
    if (repoPath) {
      paths[projectSlug] = repoPath;
    } else {
      delete paths[projectSlug];
    }

    const device = await strapi.documents(UID).update({
      documentId: existing[0].documentId,
      data: { projectPaths: paths } as any,
    });
    return { data: device };
  },

  /**
   * POST /devices/:documentId/init-project
   * Trigger project initialization on a desktop device via WebSocket.
   */
  async initProject(ctx) {
    const { projectDocumentId, repoUrl: bodyRepoUrl } = ctx.request.body as any;
    if (!projectDocumentId) {
      ctx.status = 400;
      return { error: 'projectDocumentId is required' };
    }

    // Fetch device
    const device: any = await strapi.documents(UID).findOne({
      documentId: ctx.params.documentId,
    });
    if (!device) {
      ctx.status = 404;
      return { error: 'Device not found' };
    }
    if (!device.deviceId) {
      ctx.status = 400;
      return { error: 'Device has no deviceId' };
    }

    // Fetch project
    const project: any = await strapi.documents('api::project.project' as any).findOne({
      documentId: projectDocumentId,
    });
    if (!project) {
      ctx.status = 404;
      return { error: 'Project not found' };
    }

    // Repo URL: explicit from body > project.gitRepoUrl
    const repoUrl = bodyRepoUrl || project.gitRepoUrl;
    if (!repoUrl) {
      ctx.status = 400;
      return { error: 'No repository URL configured. Set Git Repo URL in project settings.' };
    }

    const baseBranch = project.baseBranch || 'main';

    // Create agent session — desktop resolves the actual path from its projectsRoot
    const session: any = await strapi.documents(SESSION_UID).create({
      data: {
        title: `Init: ${project.slug} on ${device.name}`,
        status: 'running',
        messages: [{ role: 'user', content: 'Initialize project on device', timestamp: Date.now() }],
        project: projectDocumentId,
        metadata: { type: 'device-init', deviceId: device.deviceId, projectSlug: project.slug },
      } as any,
    });

    // Build init prompt
    const initPrompt = [
      'You are initializing a project workspace. Run these commands in order:',
      '',
      '1. Check if the directory already has a git repo:',
      '   ls .git 2>/dev/null && echo "ALREADY_CLONED" || echo "NEEDS_CLONE"',
      '',
      '2. If NEEDS_CLONE, clone the repository:',
      `   git clone -b ${baseBranch} ${repoUrl} .`,
      '',
      '3. Verify the clone succeeded:',
      '   git log --oneline -1',
      '',
      "That's it. Do not install dependencies or do anything else.",
    ].join('\n');

    // Store init status in memory
    const statusKey = `${device.deviceId}:${project.slug}`;
    initStatusMap.set(statusKey, {
      status: 'running',
      steps: { create: 'done', clone: 'running', skills: 'pending' },
      sessionId: session.documentId,
      targetPath: '',
    });

    // Resolve repo path from device record or project config
    const { resolveRepoPath } = await import('../../../services/resolve-repo-path');
    const resolvedPath = await resolveRepoPath(strapi, project.slug, device.deviceId, undefined, project.repoPath);

    sendToDevice(device.deviceId, 'agent:start', {
      sessionId: session.documentId,
      repoPath: resolvedPath,
      prompt: initPrompt,
      projectSlug: project.slug,
      projectDocumentId,
      preBuilt: true,
    });

    // Background: poll session status until completed/failed (max 5 min)
    setImmediate(() => {
      const MAX_POLLS = 100; // 100 * 3s = 300s = 5 min
      let polls = 0;
      const interval = setInterval(async () => {
        polls++;
        try {
          const updated: any = await strapi.documents(SESSION_UID).findOne({
            documentId: session.documentId,
            fields: ['status'],
          });
          if (updated?.status === 'completed') {
            clearInterval(interval);
            // Desktop already saved projectPaths via setDeviceProjectPath
            // Read back the path the desktop saved
            const freshDevice: any = await strapi.documents(UID).findOne({
              documentId: device.documentId,
              fields: ['projectPaths'],
            });

            // Notify device to sync project path into local config
            const initedPath = freshDevice?.projectPaths?.[project.slug];
            if (initedPath) {
              sendToDevice(device.deviceId, 'config:sync-project', {
                projectSlug: project.slug,
                repoPath: initedPath,
              });
            }

            // Push skills to the device now that the repo is cloned
            try {
              const skills = await strapi.documents('api::skill.skill' as any).findMany({
                filters: {
                  $or: [
                    { isGlobal: true },
                    { project: { documentId: projectDocumentId } },
                  ],
                },
                fields: ['name', 'description', 'version', 'skillMd', 'files', 'target', 'contentHash', 'localGuide'],
                limit: 100,
              });
              if ((skills as any[]).length) {
                const payload = (skills as any[]).map((s: any) => ({
                  name: s.name,
                  description: s.description || '',
                  version: s.version || '1.0.0',
                  skillMd: s.target === 'dev' ? s.skillMd : undefined,
                  localGuide: s.localGuide || undefined,
                  target: s.target || 'dev',
                  contentHash: s.contentHash || '',
                  files: s.target === 'dev' ? (s.files || []) : [],
                }));
                sendToDevice(device.deviceId, 'skills:push', { skills: payload });
                strapi.log.info(`[device-init] Pushed ${payload.length} skills to ${device.name} for ${project.slug}`);
              }
            } catch (err: any) {
              strapi.log.warn(`[device-init] Skill push failed for ${project.slug}: ${err.message}`);
            }

            const entry = initStatusMap.get(statusKey);
            if (entry) {
              entry.status = 'completed';
              entry.steps = { create: 'done', clone: 'done', skills: 'done' };
              entry.targetPath = freshDevice?.projectPaths?.[project.slug] || '';
            }
          } else if (updated?.status === 'failed') {
            clearInterval(interval);
            const entry = initStatusMap.get(statusKey);
            if (entry) {
              entry.status = 'failed';
              entry.steps.clone = 'failed';
            }
          } else if (polls >= MAX_POLLS) {
            clearInterval(interval);
            const entry = initStatusMap.get(statusKey);
            if (entry) {
              entry.status = 'failed';
              entry.steps.clone = 'failed';
            }
          }
        } catch (err) {
          strapi.log.error(`[device-init] poll error for ${statusKey}:`, err);
          if (polls >= MAX_POLLS) {
            clearInterval(interval);
          }
        }
      }, 3000);
    });

    return { data: { sessionId: session.documentId } };
  },

  // Delete a device and cascade-remove from all project pools/defaultDevice
  async deleteDevice(ctx) {
    const { documentId } = ctx.params;

    const device: any = await strapi.documents(UID).findOne({
      documentId,
      populate: ['user'],
    });
    if (!device) {
      ctx.status = 404;
      return { error: 'Device not found' };
    }
    if (ctx.state.user && device.user?.id !== ctx.state.user.id) {
      ctx.status = 403;
      return { error: 'You can only delete your own devices' };
    }

    // Remove from all project pools and unset as defaultDevice
    const PROJECT_UID = 'api::project.project' as any;
    const projects: any[] = await strapi.documents(PROJECT_UID).findMany({
      populate: ['devices', 'defaultDevice'],
    });
    for (const project of projects) {
      const inPool = project.devices?.some((d: any) => d.documentId === documentId);
      const isDefault = project.defaultDevice?.documentId === documentId;
      if (inPool || isDefault) {
        const updates: any = {};
        if (inPool) updates.devices = { disconnect: [documentId] };
        if (isDefault) updates.defaultDevice = null;
        await strapi.documents(PROJECT_UID).update({
          documentId: project.documentId,
          data: updates,
        });
      }
    }

    await strapi.documents(UID).delete({ documentId });
    return { data: { ok: true } };
  },

  /**
   * GET /devices/:documentId/init-status/:projectSlug
   * Return the in-memory init status for a device + project.
   */
  async initStatus(ctx) {
    const device: any = await strapi.documents(UID).findOne({
      documentId: ctx.params.documentId,
      fields: ['deviceId'],
    });
    if (!device) {
      ctx.status = 404;
      return { error: 'Device not found' };
    }

    const key = `${device.deviceId}:${ctx.params.projectSlug}`;
    const status = initStatusMap.get(key);
    return { data: status || { status: 'unknown' } };
  },

  async syncSkills(ctx) {
    const SKILL_UID = 'api::skill.skill' as any;
    const skills = await strapi.documents(SKILL_UID).findMany({ limit: 200 });
    const payload = (skills as any[]).map((s: any) => ({
      name: s.name,
      description: s.description || '',
      version: s.version || '1.0.0',
      skillMd: s.target === 'dev' ? s.skillMd : undefined,
      localGuide: s.localGuide || undefined,
      target: s.target || 'dev',
      contentHash: s.contentHash || '',
      files: s.target === 'dev' ? (s.files || []) : [],
    }));

    const devices = await strapi.documents(UID).findMany({ limit: 50 });
    const results: { deviceId: string; name: string; sent: boolean }[] = [];
    for (const d of devices as any[]) {
      if (!d.deviceId) continue;
      const sent = sendToDevice(d.deviceId, 'skills:push', { skills: payload });
      results.push({ deviceId: d.deviceId, name: d.name, sent });
    }

    return { data: { skillCount: payload.length, devices: results } };
  },
}));
