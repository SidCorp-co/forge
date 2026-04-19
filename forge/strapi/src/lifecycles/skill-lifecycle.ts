import crypto from 'crypto';
import { upsertEmbedding, removeEmbeddings, sanitizeContent } from '../services/embeddings';
import { getConnectedDeviceIds, sendToDevice } from '../services/websocket';

interface ChangelogEntry {
  version: string;
  hash: string;
  timestamp: string;
  summary: string;
  previousContent?: string;
}

const MAX_CHANGELOG_WITH_CONTENT = 10;

function computeContentHash(skillMd: string, files?: any[]): string {
  const sortedFiles = (files || [])
    .slice()
    .sort((a: any, b: any) => (a.path || '').localeCompare(b.path || ''));
  const payload = skillMd + JSON.stringify(sortedFiles);
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function generateLocalGuide(skill: { name: string; description: string; version: string; target: string }): string | null {
  if (skill.target === 'dev') return null;
  return `# ${skill.name}\n${skill.description}\n\nThis skill's full content is managed in Forge cloud.\nTo load the current version, call: forge_skills get ${skill.name}\n\nVersion: ${skill.version} | Target: ${skill.target}`;
}

/** Detect if text is a localGuide placeholder (not real skill content). */
function isLocalGuideContent(text: string): boolean {
  return text.includes('full content is managed in Forge cloud');
}

export function subscribeSkillLifecycles(strapi: any) {
  strapi.db.lifecycles.subscribe({
    models: ['api::skill.skill'],

    async beforeCreate(event: any) {
      const { data } = event.params;
      if (data.skillMd) {
        data.contentHash = computeContentHash(data.skillMd, data.files);
        const entry: ChangelogEntry = {
          version: data.version || '1.0.0',
          hash: data.contentHash,
          timestamp: new Date().toISOString(),
          summary: 'Initial version',
          previousContent: undefined,
        };
        data.changelog = [entry];
        data.localGuide = generateLocalGuide({
          name: data.name,
          description: data.description || '',
          version: data.version || '1.0.0',
          target: data.target || 'dev',
        });
      }
    },

    async beforeUpdate(event: any) {
      const { data, where } = event.params;

      const existing = await strapi.db.query('api::skill.skill').findOne({ where });
      if (!existing) return;

      // Auto-increment patch version on every update (unless version is explicitly set)
      if (!data.version) {
        if (existing.version) {
          const parts = existing.version.split('.').map(Number);
          parts[2] = (parts[2] || 0) + 1;
          data.version = parts.join('.');
        }
      }

      // Compute new contentHash if skillMd or files changed
      const newSkillMd = data.skillMd ?? existing.skillMd;
      const newFiles = data.files ?? existing.files;
      const newHash = computeContentHash(newSkillMd, newFiles);

      if (newHash !== existing.contentHash) {
        data.contentHash = newHash;

        // Append changelog entry
        const changelog: ChangelogEntry[] = Array.isArray(existing.changelog) ? [...existing.changelog] : [];
        const entry: ChangelogEntry = {
          version: data.version || existing.version,
          hash: newHash,
          timestamp: new Date().toISOString(),
          summary: data.skillMd && data.skillMd !== existing.skillMd ? 'Content updated' : 'Files updated',
          previousContent: existing.skillMd,
        };
        changelog.push(entry);

        // Keep full content only for last N entries
        if (changelog.length > MAX_CHANGELOG_WITH_CONTENT) {
          for (let i = 0; i < changelog.length - MAX_CHANGELOG_WITH_CONTENT; i++) {
            delete changelog[i].previousContent;
          }
        }
        data.changelog = changelog;
      }

      // Guard: reject localGuide placeholder being written to skillMd
      if (data.skillMd && isLocalGuideContent(data.skillMd)) {
        strapi.log.warn(`[skill] Blocked localGuide text from overwriting skillMd for "${data.name ?? existing.name}"`);
        delete data.skillMd;
      }

      // Regenerate localGuide
      data.localGuide = generateLocalGuide({
        name: data.name ?? existing.name,
        description: data.description ?? existing.description,
        version: data.version ?? existing.version,
        target: data.target ?? existing.target,
      });
    },

    async afterCreate(event: any) {
      const { result } = event;
      setImmediate(() => {
        embedSkill(strapi, result).catch((err: any) =>
          strapi.log.warn(`[embed] skill create: ${err.message}`));
        pushSkillToAllDevices(strapi, result).catch((err: any) =>
          strapi.log.warn(`[skill-push] create: ${err.message}`));
      });
    },

    async afterUpdate(event: any) {
      const { result } = event;
      setImmediate(() => {
        embedSkill(strapi, result).catch((err: any) =>
          strapi.log.warn(`[embed] skill update: ${err.message}`));
        pushSkillToAllDevices(strapi, result).catch((err: any) =>
          strapi.log.warn(`[skill-push] update: ${err.message}`));
      });
    },

    async afterDelete(event: any) {
      const { result } = event;
      if (result?.documentId) {
        setImmediate(() => {
          removeEmbeddings('skill', result.documentId).catch((err: any) =>
            strapi.log.warn(`[embed] skill delete: ${err.message}`));
        });
      }
    },
  });
}

/**
 * Backfill contentHash, changelog, and localGuide for existing skills
 * that were created before these fields existed.
 */
export async function backfillSkillHashes(strapi: any) {
  const skills = await strapi.db.query('api::skill.skill').findMany({
    where: {
      $or: [
        { contentHash: null },
        { contentHash: '' },
      ],
    },
    limit: 500,
  });

  if (!skills.length) return;
  strapi.log.info(`[skill] Backfilling ${skills.length} skills with contentHash/changelog/localGuide`);

  for (const skill of skills) {
    if (!skill.skillMd) continue;
    const hash = computeContentHash(skill.skillMd, skill.files);
    const changelog: ChangelogEntry[] = [{
      version: skill.version || '1.0.0',
      hash,
      timestamp: skill.updatedAt || new Date().toISOString(),
      summary: 'Backfilled from existing skill',
    }];
    const localGuide = generateLocalGuide({
      name: skill.name,
      description: skill.description || '',
      version: skill.version || '1.0.0',
      target: skill.target || 'dev',
    });

    await strapi.db.query('api::skill.skill').update({
      where: { id: skill.id },
      data: { contentHash: hash, changelog, localGuide },
    });
  }

  strapi.log.info(`[skill] Backfill complete: ${skills.length} skills updated`);
}

/** Push a single skill update to all connected desktop devices. */
async function pushSkillToAllDevices(strapi: any, result: any) {
  const deviceIds = getConnectedDeviceIds();
  if (!deviceIds.length) return;

  const skill = await strapi.documents('api::skill.skill').findOne({
    documentId: result.documentId,
    populate: ['project'],
  });
  if (!skill) return;

  const payload = [{
    name: skill.name,
    description: skill.description || '',
    version: skill.version || '1.0.0',
    skillMd: skill.target === 'dev' ? skill.skillMd : undefined,
    localGuide: skill.localGuide || undefined,
    target: skill.target || 'dev',
    contentHash: skill.contentHash || '',
    files: skill.target === 'dev' ? (skill.files || []) : [],
  }];

  let sent = 0;
  for (const deviceId of deviceIds) {
    if (sendToDevice(deviceId, 'skills:push', { skills: payload })) sent++;
  }
  if (sent > 0) {
    strapi.log.info(`[skill-push] Pushed "${skill.name}" to ${sent} device(s)`);
  }
}

async function embedSkill(strapi: any, result: any) {
  const skill = await strapi.documents('api::skill.skill').findOne({
    documentId: result.documentId,
    populate: ['project'],
  });
  if (!skill) return;

  // Embed cloud and all-target skills (used by web chat agent via RAG)
  if (skill.target === 'dev') return;

  const text = [skill.name, skill.description, skill.skillMd]
    .filter(Boolean).join('\n\n');
  if (text.length < 20) return;

  const sanitized = sanitizeContent(text);
  const metadata = { title: skill.name, updatedAt: new Date().toISOString() };

  if (skill.project?.documentId) {
    await upsertEmbedding({
      project_id: skill.project.documentId,
      source_type: 'skill',
      source_id: skill.documentId,
      text: sanitized,
      metadata,
    });
  } else if (skill.isGlobal) {
    // Global skill — embed for every project (batched, max 50)
    const projects: any[] = await strapi.documents('api::project.project' as any).findMany({ limit: 50 });
    for (const project of projects) {
      await upsertEmbedding({
        project_id: project.documentId,
        source_type: 'skill',
        source_id: skill.documentId,
        text: sanitized,
        metadata,
      });
    }
  }
}
