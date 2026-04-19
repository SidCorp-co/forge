import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { ForgeTool } from './tools';

const VALID_ENCODINGS = new Set(['utf8', 'base64']);

function validateFiles(files: any[]): string | null {
  for (const f of files) {
    if (!f || typeof f !== 'object') return 'Each file must be an object';
    if (!f.path || typeof f.path !== 'string') return `File missing "path" string field`;
    if (/\.\./.test(f.path)) return `File path "${f.path}" must not contain ".."`;
    if (typeof f.content !== 'string') return `File "${f.path}" missing "content" string field`;
    if (!f.encoding || !VALID_ENCODINGS.has(f.encoding)) {
      return `File "${f.path}" has invalid encoding "${f.encoding}" (must be "utf8" or "base64")`;
    }
  }
  return null;
}

export const forgeSkills: ForgeTool = {
  name: 'forge_skills',
  description: 'Skills: list, get (by name), check versions, push, add-files, pull (generates local sync script), changelog (version history), rollback (revert to previous version), sync (push to devices). For external REST integration, call forge_integration_guide.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'get', 'check', 'push', 'add-files', 'pull', 'changelog', 'rollback', 'sync'] },
      name: { type: 'string', description: 'Skill name (for get/add-files/changelog/rollback). For pull: optional — omit to pull all changed skills.' },
      target: { type: 'string', enum: ['dev', 'cloud', 'all'], description: 'Filter skills by target platform (for list/check). Returns skills matching this target or "all".' },
      data: { type: 'object', description: 'push: {name, skillMd, description?, files?, isGlobal?}. add-files: {files}. pull: {skillsDir}. rollback: {version}. sync: {targets: ["all"|"antigravity"|"desktop"]}.' },
    },
    required: ['action'],
  },
  async execute(input, ctx) {
    const action = input.action as string;
    const docs = ctx.strapi.documents('api::skill.skill' as any);

    if (action === 'list') {
      const targetFilter = input.target as string | undefined;
      const filters: any = {
        $or: [
          { project: { documentId: { $eq: ctx.projectDocumentId } } },
          { isGlobal: { $eq: true } },
        ],
      };
      if (targetFilter) {
        const wrappedFilters = {
          $and: [
            { $or: filters.$or },
            { target: { $in: [targetFilter, 'all'] } },
          ],
        };
        Object.assign(filters, wrappedFilters);
        delete filters.$or;
      }
      const skills = await docs.findMany({ filters });
      return JSON.stringify(
        (skills as any[]).map((s: any) => ({
          name: s.name,
          version: s.version,
          description: s.description,
          isGlobal: s.isGlobal,
          target: s.target || 'dev',
          updatedAt: s.updatedAt,
        })),
      );
    }

    if (action === 'get') {
      const name = input.name as string;
      if (!name) return 'Error: name required for get action';
      const skills = await docs.findMany({
        filters: { name: { $eq: name } },
        limit: 1,
      });
      if (!(skills as any[]).length) return 'Skill not found';
      const s = (skills as any[])[0];

      // Detect corrupted skillMd (localGuide placeholder overwritten into skillMd field)
      // and recover real content from changelog's previousContent
      let skillMd = s.skillMd;
      if (skillMd && skillMd.includes('full content is managed in Forge cloud')) {
        const changelog: any[] = Array.isArray(s.changelog) ? s.changelog : [];
        // Find the latest changelog entry with previousContent (the real skill content)
        for (let i = changelog.length - 1; i >= 0; i--) {
          if (changelog[i].previousContent) {
            skillMd = changelog[i].previousContent;
            break;
          }
        }
      }

      return JSON.stringify({
        name: s.name,
        version: s.version,
        description: s.description,
        skillMd,
        files: s.files || [],
      });
    }

    if (action === 'check') {
      const targetFilter = input.target as string | undefined;
      const filters: any = {
        $or: [
          { project: { documentId: { $eq: ctx.projectDocumentId } } },
          { isGlobal: { $eq: true } },
        ],
      };
      if (targetFilter) {
        const wrappedFilters = {
          $and: [
            { $or: filters.$or },
            { target: { $in: [targetFilter, 'all'] } },
          ],
        };
        Object.assign(filters, wrappedFilters);
        delete filters.$or;
      }
      const skills = await docs.findMany({ filters });
      return JSON.stringify(
        (skills as any[]).map((s: any) => ({
          name: s.name,
          version: s.version,
          target: s.target || 'dev',
          updatedAt: s.updatedAt,
        })),
      );
    }

    if (action === 'push') {
      const data = input.data as Record<string, any>;
      if (!data?.name || !data?.skillMd) return 'Error: data.name and data.skillMd required for push';
      if (/[/\\]|\.\./.test(data.name)) return 'Error: skill name must not contain path separators or ".."';

      // Validate files structure if provided
      if (data.files?.length) {
        const fileErr = validateFiles(data.files);
        if (fileErr) return `Error: ${fileErr}`;
      }

      // Check if skill already exists — update it
      const existing = await docs.findMany({
        filters: { name: { $eq: data.name } },
        limit: 1,
      });

      if ((existing as any[]).length) {
        const skill = (existing as any[])[0];
        const updateData: Record<string, any> = {
          description: data.description || skill.description,
          skillMd: data.skillMd,
          files: data.files || skill.files,
          isGlobal: data.isGlobal ?? skill.isGlobal,
        };
        if (data.version) updateData.version = data.version;
        // version auto-incremented by lifecycle hook when not explicitly set
        const updated = await docs.update({
          documentId: skill.documentId,
          data: updateData,
        });
        return JSON.stringify({
          documentId: (updated as any).documentId,
          name: data.name,
          version: (updated as any).version,
          status: 'updated',
        });
      }

      // Create new skill
      const createData: Record<string, any> = {
        name: data.name,
        description: data.description || '',
        skillMd: data.skillMd,
        files: data.files || [],
        isGlobal: data.isGlobal ?? false,
        project: { documentId: ctx.projectDocumentId },
      };
      if (data.version) createData.version = data.version;
      const created = await docs.create({
        data: createData,
      });
      return JSON.stringify({
        documentId: (created as any).documentId,
        name: data.name,
        version: (created as any).version,
        status: 'created',
      });
    }

    if (action === 'add-files') {
      const name = input.name as string;
      const data = input.data as Record<string, any>;
      if (!name) return 'Error: name required for add-files action';
      if (!data?.files?.length) return 'Error: data.files array required for add-files action';

      const fileErr = validateFiles(data.files);
      if (fileErr) return `Error: ${fileErr}`;

      const skills = await docs.findMany({
        filters: { name: { $eq: name } },
        limit: 1,
      });
      if (!(skills as any[]).length) return `Skill "${name}" not found`;

      const skill = (skills as any[])[0];
      const existingFiles: any[] = skill.files || [];
      const newFiles: any[] = data.files;

      // Merge: new files overwrite existing by path, others are kept
      const fileMap = new Map<string, any>();
      for (const f of existingFiles) fileMap.set(f.path, f);
      for (const f of newFiles) fileMap.set(f.path, f);
      const mergedFiles = Array.from(fileMap.values());

      const updated = await docs.update({
        documentId: skill.documentId,
        data: { files: mergedFiles },
      });

      return JSON.stringify({
        documentId: (updated as any).documentId,
        name,
        version: (updated as any).version,
        fileCount: mergedFiles.length,
        added: newFiles.length,
        status: 'files_added',
      });
    }

    if (action === 'pull') {
      const data = (input.data as Record<string, any>) || {};
      const skillsDir = data.skillsDir || '.claude/skills';
      const targetName = input.name as string | undefined;

      const baseUrl = data.apiUrl
        || process.env.STRAPI_URL
        || 'http://localhost:1337';

      // Query DB with project filter (relation not available via public API)
      const filters: any = {
        $or: [
          { project: { documentId: { $eq: ctx.projectDocumentId } } },
          { isGlobal: { $eq: true } },
        ],
      };
      if (targetName) {
        filters.name = { $eq: targetName };
      }
      const skills = await docs.findMany({ filters, limit: 200 });
      const skillList = skills as any[];

      if (!skillList.length) {
        return targetName ? `Skill "${targetName}" not found` : 'No skills found';
      }

      // Build manifest baked into the script (project-filtered server-side)
      // For cloud/all-target skills, include localGuide content so the pull script
      // writes a thin guide instead of full content
      const manifest = skillList
        .filter((s: any) => s.name !== 'forge-skill')
        .map((s: any) => ({
          n: s.name,
          d: s.documentId,
          t: s.target || 'dev',
          g: s.localGuide || null,
        }));

      // Read static template from public/skill-pull.py
      const templatePath = path.join(ctx.strapi.dirs.static.public, 'skill-pull.py');
      const template = fs.readFileSync(templatePath, 'utf-8');

      // Inject config into template
      const script = template
        .replace('__API__', JSON.stringify(baseUrl))
        .replace('__SKILLS_DIR__', JSON.stringify(skillsDir))
        .replace('__MANIFEST__', JSON.stringify(manifest));

      // Write to public/tmp/ with cleanup of old files (>1h)
      const tmpDir = path.join(ctx.strapi.dirs.static.public, 'tmp');
      fs.mkdirSync(tmpDir, { recursive: true });
      const now = Date.now();
      for (const f of fs.readdirSync(tmpDir)) {
        try {
          const stat = fs.statSync(path.join(tmpDir, f));
          if (now - stat.mtimeMs > 3600_000) fs.unlinkSync(path.join(tmpDir, f));
        } catch { /* ignore */ }
      }

      const hash = crypto.randomBytes(6).toString('hex');
      const filename = `skill-pull-${hash}.py`;
      fs.writeFileSync(path.join(tmpDir, filename), script, 'utf-8');

      return JSON.stringify({
        run: `curl -s ${baseUrl}/tmp/${filename} -o /tmp/skill-pull.py && python3 /tmp/skill-pull.py`,
      });
    }

    if (action === 'changelog') {
      const name = input.name as string;
      if (!name) return 'Error: name required for changelog action';
      const skills = await docs.findMany({
        filters: { name: { $eq: name } },
        limit: 1,
      });
      if (!(skills as any[]).length) return `Skill "${name}" not found`;
      const s = (skills as any[])[0];
      const changelog = Array.isArray(s.changelog) ? s.changelog : [];
      return JSON.stringify(
        changelog.map((entry: any) => ({
          version: entry.version,
          hash: entry.hash,
          timestamp: entry.timestamp,
          summary: entry.summary,
        })),
      );
    }

    if (action === 'rollback') {
      const name = input.name as string;
      const data = input.data as Record<string, any>;
      if (!name) return 'Error: name required for rollback action';
      if (!data?.version) return 'Error: data.version required for rollback action';

      const skills = await docs.findMany({
        filters: { name: { $eq: name } },
        limit: 1,
      });
      if (!(skills as any[]).length) return `Skill "${name}" not found`;
      const skill = (skills as any[])[0];
      const changelog = Array.isArray(skill.changelog) ? skill.changelog : [];

      // Find the target version entry with previousContent
      const targetEntry = changelog.find((e: any) => e.version === data.version);
      if (!targetEntry) return `Version "${data.version}" not found in changelog`;

      // For rollback, we need either the previousContent from the NEXT version,
      // or the content from this entry itself
      // The entry at index i has previousContent = content BEFORE that version was applied
      const targetIdx = changelog.indexOf(targetEntry);

      // To restore version X, we need the content that was current at version X.
      // That content is stored as previousContent in the entry AFTER X (if it exists).
      // If X is the latest entry, the current skillMd IS version X.
      let restoreContent: string | undefined;
      if (targetIdx === changelog.length - 1) {
        // Target is the current version — nothing to rollback
        return `Skill "${name}" is already at version ${data.version}`;
      } else if (targetIdx < changelog.length - 1) {
        restoreContent = changelog[targetIdx + 1]?.previousContent;
      }

      if (!restoreContent) {
        return `Cannot rollback: content for version ${data.version} is no longer available (only last 10 versions store content)`;
      }

      const updated = await docs.update({
        documentId: skill.documentId,
        data: { skillMd: restoreContent },
      });

      return JSON.stringify({
        documentId: (updated as any).documentId,
        name,
        version: (updated as any).version,
        status: 'rolled_back',
        restoredFrom: data.version,
      });
    }

    if (action === 'sync') {
      const data = (input.data as Record<string, any>) || {};
      const targets = data.targets as string[] || ['all'];

      // Fetch all relevant skills
      const skills = await docs.findMany({
        filters: {
          $or: [
            { project: { documentId: { $eq: ctx.projectDocumentId } } },
            { isGlobal: { $eq: true } },
          ],
        },
        limit: 100,
      });
      const skillList = skills as any[];
      if (!skillList.length) return 'No skills to sync';

      const results: any[] = [];

      const shouldSyncDesktop = targets.includes('all') || targets.includes('desktop');
      const shouldSyncAntigravity = targets.includes('all') || targets.includes('antigravity');

      if (shouldSyncDesktop) {
        const allDevices = await ctx.strapi.documents('api::device.device' as any).findMany({
          filters: { status: { $ne: 'disabled' } },
          limit: 50,
        });
        const devices: any[] = (allDevices || []).filter((d: any) => d.deviceId);
        if (devices.length) {
          const { sendToDevice } = await import('../websocket');
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
          for (const device of devices) {
            const sent = sendToDevice(device.deviceId, 'skills:push', { skills: payload });
            results.push({ target: 'desktop', deviceId: device.deviceId, deviceName: device.name, sent, skillCount: payload.length });
          }
        } else {
          results.push({ target: 'desktop', error: 'No devices found' });
        }
      }

      if (shouldSyncAntigravity && ctx.projectDocumentId) {
        try {
          const { syncSkills } = await import('../antigravity');
          const project = await ctx.strapi.documents('api::project.project' as any).findOne({
            documentId: ctx.projectDocumentId,
            fields: ['antigravityProjectId'],
          });
          if (project?.antigravityProjectId) {
            const result = await syncSkills(ctx.strapi, project.antigravityProjectId, ctx.projectDocumentId);
            results.push({ target: 'antigravity', ...result });
          } else {
            results.push({ target: 'antigravity', error: 'No Antigravity project configured' });
          }
        } catch (err: any) {
          results.push({ target: 'antigravity', error: err.message });
        }
      }

      return JSON.stringify({ synced: true, results });
    }

    return `Unknown action: ${action}`;
  },
};
