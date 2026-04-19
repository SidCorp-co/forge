/**
 * Skills Sync
 *
 * Sync skills from Strapi to Antigravity projects (single or all).
 */

import { uploadProjectConfig } from './client';
import { buildSkillsZip } from './skills-zip';

/**
 * Sync skills from Strapi to an Antigravity project.
 * Builds a zip of all relevant skills and uploads it.
 */
export async function syncSkills(
    strapi: any,
    antigravityProjectId: string,
    projectDocumentId?: string,
): Promise<{ ok: boolean; skillCount: number }> {
    // Fetch project apiKey to bake into the generated CLI
    let projectApiKey: string | undefined;
    if (projectDocumentId) {
        const proj = await strapi.documents('api::project.project' as any).findOne({
            documentId: projectDocumentId,
            fields: ['apiKey'],
        });
        projectApiKey = proj?.apiKey || undefined;
    }

    const { buffer, skillCount } = await buildSkillsZip(strapi, projectDocumentId, projectApiKey);

    if (skillCount === 0) {
        return { ok: true, skillCount: 0 };
    }

    await uploadProjectConfig(antigravityProjectId, buffer, 'skills.zip', false);

    // Update skillsSyncedAt on the project if we know which project it is
    if (projectDocumentId) {
        await strapi.documents('api::project.project' as any).update({
            documentId: projectDocumentId,
            data: { skillsSyncedAt: new Date().toISOString() },
        });
    }

    return { ok: true, skillCount };
}

/**
 * Sync skills to ALL projects that have an Antigravity project configured.
 * Used when skills are updated globally and need to propagate to all runners.
 */
export async function syncSkillsToAll(
    strapi: any,
): Promise<{ ok: boolean; results: Array<{ projectId: string; antigravityProjectId: string; skillCount: number; error?: string }> }> {
    // Fetch all projects that have any Antigravity config (legacy or runner pool)
    const projects: any[] = await strapi.documents('api::project.project' as any).findMany({
        fields: ['documentId', 'name', 'antigravityProjectId', 'antigravityProjectMap'],
        populate: { antigravityRunners: true },
        limit: 100,
    });

    // Build a runnerId → endpoint lookup
    const results: Array<{ projectId: string; antigravityProjectId: string; skillCount: number; error?: string }> = [];

    for (const project of projects) {
        const projectMap: Record<string, string> = project.antigravityProjectMap || {};
        const hasRunnerPool = (project.antigravityRunners || []).length > 0 && Object.keys(projectMap).length > 0;

        if (hasRunnerPool) {
            // Sync to each runner in the pool — all calls go through proxy
            for (const [runnerId, agProjectId] of Object.entries(projectMap)) {
                try {
                    const { skillCount } = await syncSkills(strapi, agProjectId, project.documentId);
                    results.push({ projectId: project.documentId, antigravityProjectId: agProjectId, skillCount });
                } catch (err: any) {
                    strapi.log.error(`[antigravity] syncSkillsToAll: project ${project.name} runner ${runnerId} failed: ${err.message}`);
                    results.push({ projectId: project.documentId, antigravityProjectId: agProjectId, skillCount: 0, error: err.message });
                }
            }
        } else if (project.antigravityProjectId) {
            // Legacy single-instance
            try {
                const { skillCount } = await syncSkills(strapi, project.antigravityProjectId, project.documentId);
                results.push({ projectId: project.documentId, antigravityProjectId: project.antigravityProjectId, skillCount });
            } catch (err: any) {
                strapi.log.error(`[antigravity] syncSkillsToAll: project ${project.name} failed: ${err.message}`);
                results.push({ projectId: project.documentId, antigravityProjectId: project.antigravityProjectId, skillCount: 0, error: err.message });
            }
        }
    }

    return { ok: results.every((r) => !r.error), results };
}

/**
 * Check if skills need syncing for a project by comparing contentHash values.
 * Falls back to timestamp comparison for skills without contentHash.
 */
export async function needsSkillSync(strapi: any, projectDocumentId: string): Promise<boolean> {
    const project = await strapi.documents('api::project.project' as any).findOne({
        documentId: projectDocumentId,
        fields: ['skillsSyncedAt'],
    });

    const syncedAt = project?.skillsSyncedAt ? new Date(project.skillsSyncedAt).getTime() : 0;

    // Find the most recently updated skill (global or project-specific)
    const latestSkills = await strapi.db.query('api::skill.skill').findMany({
        where: {
            $or: [
                { isGlobal: true },
                { project: { documentId: projectDocumentId } },
            ],
        },
        orderBy: { updatedAt: 'desc' },
        limit: 1,
    });

    if (!latestSkills.length) return false;

    const latestUpdatedAt = new Date(latestSkills[0].updatedAt).getTime();
    return latestUpdatedAt > syncedAt;
}
