import { factories } from '@strapi/strapi';
import { uploadProjectConfig, zipEntry, assembleZip, syncSkills } from '../../../services/antigravity';
import { sendToDevice } from '../../../services/websocket';

const VALID_ENCODINGS = new Set(['utf8', 'base64']);
const UNSAFE_PATH_RE = /[/\\]|\.\./;

interface SkillFile {
  path: string;
  content: string;
  encoding: string;
}

interface SkillPayload {
  name: string;
  skillMd: string;
  files?: SkillFile[];
}

function validateSkills(skills: any[]): string | null {
  for (const s of skills) {
    if (!s || typeof s !== 'object') return 'Each skill must be an object';
    if (!s.name || typeof s.name !== 'string') return 'Each skill requires a "name" string';
    if (UNSAFE_PATH_RE.test(s.name)) return `Skill name "${s.name}" must not contain path separators or ".."`;
    if (!s.skillMd || typeof s.skillMd !== 'string') return 'Each skill requires a "skillMd" string';
    if (s.files?.length) {
      for (const f of s.files) {
        if (!f || typeof f !== 'object') return `Skill "${s.name}": each file must be an object`;
        if (!f.path || typeof f.path !== 'string') return `Skill "${s.name}": file missing "path" string`;
        if (/\.\./.test(f.path)) return `Skill "${s.name}": file path "${f.path}" must not contain ".."`;

        if (typeof f.content !== 'string') return `Skill "${s.name}": file "${f.path}" missing "content" string`;
        if (!f.encoding || !VALID_ENCODINGS.has(f.encoding)) {
          return `Skill "${s.name}": file "${f.path}" has invalid encoding "${f.encoding}" (must be "utf8" or "base64")`;
        }
      }
    }
  }
  return null;
}

async function buildSkillsZipFromPayload(skills: SkillPayload[]): Promise<Buffer> {
  const entries: Array<{ path: string; data: Buffer; compressed: Buffer; crc: number }> = [];

  for (const skill of skills) {
    // Add SKILL.md
    const data = Buffer.from(skill.skillMd, 'utf-8');
    entries.push(await zipEntry(`skills/${skill.name}/SKILL.md`, data));

    // Add reference files
    if (skill.files?.length) {
      for (const file of skill.files) {
        const fileData = file.encoding === 'base64'
          ? Buffer.from(file.content, 'base64')
          : Buffer.from(file.content, 'utf-8');
        entries.push(await zipEntry(`skills/${skill.name}/${file.path}`, fileData));
      }
    }
  }

  return assembleZip(entries);
}

export default factories.createCoreController('api::skill.skill', () => ({
  /**
   * POST /api/skills/push-antigravity
   * Accepts skill definitions, packages into skills.zip, uploads to Antigravity project.
   * Forge does not persist these skills — the external system is the source of truth.
   */
  async pushAntigravity(ctx: any) {
    const { skills, projectId } = ctx.request.body || {};

    // Resolve Antigravity project ID: explicit or from API key's project
    let antigravityProjectId = projectId;
    if (!antigravityProjectId && ctx.state.forgeProject) {
      antigravityProjectId = ctx.state.forgeProject.antigravityProjectId;
    }
    if (!antigravityProjectId) {
      return ctx.badRequest('projectId is required (Antigravity project ID), or use a project API key with Antigravity configured');
    }

    if (!Array.isArray(skills) || !skills.length) {
      return ctx.badRequest('skills array is required');
    }

    const validationError = validateSkills(skills);
    if (validationError) {
      return ctx.badRequest(validationError);
    }

    try {
      const zipBuffer = await buildSkillsZipFromPayload(skills);
      await uploadProjectConfig(antigravityProjectId, zipBuffer, 'skills.zip', false);
      ctx.body = { data: { ok: true, skillCount: skills.length, projectId: antigravityProjectId } };
    } catch (err: any) {
      strapi.log.error(`[skill] pushAntigravity error: ${err.message}`);
      ctx.status = 502;
      ctx.body = { error: `Failed to upload skills to Antigravity: ${err.message}` };
    }
  },

  /**
   * POST /api/skills/push-claude
   * Accepts skill definitions, sends to connected Claude desktop device via WebSocket.
   * The desktop app writes skills to its local .claude/skills/ directory.
   */
  async pushClaude(ctx: any) {
    const { skills, deviceId } = ctx.request.body || {};

    if (!Array.isArray(skills) || !skills.length) {
      return ctx.badRequest('skills array is required');
    }

    const validationError = validateSkills(skills);
    if (validationError) {
      return ctx.badRequest(validationError);
    }

    // Resolve device: explicit deviceId, or project's default device
    let targetDeviceId = deviceId;
    if (!targetDeviceId && ctx.state.forgeProject) {
      const project = await strapi.documents('api::project.project' as any).findOne({
        documentId: ctx.state.forgeProject.documentId,
        populate: ['defaultDevice'],
      });
      targetDeviceId = project?.defaultDevice?.deviceId;
    }
    if (!targetDeviceId) {
      return ctx.badRequest('deviceId is required, or use a project API key with a default device configured');
    }

    const sent = sendToDevice(targetDeviceId, 'skills:push', { skills });
    if (!sent) {
      ctx.status = 503;
      ctx.body = { error: 'Device not connected' };
      return;
    }

    ctx.body = { data: { ok: true, skillCount: skills.length, deviceId: targetDeviceId } };
  },

  /**
   * POST /api/skills/sync-status
   * Returns per-skill sync state with contentHash comparison.
   */
  async syncStatus(ctx: any) {
    const { projectDocumentId } = ctx.request.body || {};
    if (!projectDocumentId) {
      return ctx.badRequest('projectDocumentId is required');
    }

    const skills = await strapi.documents('api::skill.skill' as any).findMany({
      filters: {
        $or: [
          { isGlobal: true },
          { project: { documentId: projectDocumentId } },
        ],
      },
    });

    // Get project's sync timestamp
    const project = await strapi.documents('api::project.project' as any).findOne({
      documentId: projectDocumentId,
      populate: ['defaultDevice'],
    });

    const syncedAt = project?.skillsSyncedAt || null;
    const deviceId = project?.defaultDevice?.deviceId || null;

    const data = (skills as any[]).map((s: any) => ({
      skillName: s.name,
      currentHash: s.contentHash || null,
      currentVersion: s.version,
      target: s.target || 'dev',
      isGlobal: s.isGlobal || false,
      updatedAt: s.updatedAt,
      devices: deviceId ? [{
        deviceId,
        inSync: syncedAt ? new Date(s.updatedAt).getTime() <= new Date(syncedAt).getTime() : false,
      }] : [],
    }));

    ctx.body = { data };
  },

  /**
   * POST /api/skills/bulk-push
   * Push skills to multiple targets, only pushing changed skills.
   */
  async bulkPush(ctx: any) {
    const { targets, skillNames, projectDocumentId } = ctx.request.body || {};
    if (!Array.isArray(targets) || !targets.length) {
      return ctx.badRequest('targets array is required');
    }

    // Resolve project
    const projDocId = projectDocumentId || ctx.state.forgeProject?.documentId;
    if (!projDocId) {
      return ctx.badRequest('projectDocumentId is required');
    }

    // Fetch skills
    const filters: any = {
      $or: [
        { isGlobal: true },
        { project: { documentId: projDocId } },
      ],
    };
    if (skillNames?.length) {
      filters.name = { $in: skillNames };
    }

    const skills = await strapi.documents('api::skill.skill' as any).findMany({
      filters,
      limit: 100,
    });
    const skillList = skills as any[];

    if (!skillList.length) {
      ctx.body = { data: { results: [] } };
      return;
    }

    const results: any[] = [];

    for (const target of targets) {
      if (target.startsWith('device:')) {
        const deviceId = target.slice('device:'.length);
        const payload = skillList.map((s: any) => ({
          name: s.name,
          description: s.description || '',
          version: s.version || '1.0.0',
          skillMd: s.target === 'dev' ? s.skillMd : undefined,
          localGuide: s.localGuide || undefined,
          target: s.target || 'dev',
          contentHash: s.contentHash || '',
          files: s.target === 'dev' ? (s.files || []) : [],
        }));
        const sent = sendToDevice(deviceId, 'skills:push', { skills: payload });
        results.push({
          target,
          pushed: sent ? skillList.map((s: any) => s.name) : [],
          skipped: [],
          errors: sent ? [] : ['Device not connected'],
        });
        if (sent) {
          await strapi.documents('api::project.project' as any).update({
            documentId: projDocId,
            data: { skillsSyncedAt: new Date().toISOString() },
          });
        }
      } else if (target.startsWith('antigravity:')) {
        const antigravityProjectId = target.slice('antigravity:'.length);
        try {
          const result = await syncSkills(strapi, antigravityProjectId, projDocId);
          results.push({
            target,
            pushed: result.skillCount > 0 ? skillList.map((s: any) => s.name) : [],
            skipped: [],
            errors: [],
          });
        } catch (err: any) {
          results.push({ target, pushed: [], skipped: [], errors: [err.message] });
        }
      }
    }

    ctx.body = { data: { results } };
  },
}));
