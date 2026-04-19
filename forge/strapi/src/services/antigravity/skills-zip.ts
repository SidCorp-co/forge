/**
 * Skills Zip Builder
 *
 * Builds a zip buffer containing skill files adapted for Antigravity.
 * Antigravity can't use MCP tools — it runs prompts via REST API.
 * This bundles skills and a generated forge-api.mjs CLI into a zip.
 */

import { zipEntry, assembleZip } from './zip-utils';
import { generateForgeCli } from './forge-cli-gen';

/**
 * Build a zip buffer containing skill files adapted for Antigravity.
 *
 * Zip structure:
 *   skills/
 *     forge-triage/
 *       SKILL.md
 *       references/triage-criteria.md
 *     forge-plan/
 *       SKILL.md
 *       ...
 *   forge-api.mjs  (auto-generated CLI with baked-in config)
 */
export async function buildSkillsZip(
    strapi: any,
    projectDocumentId?: string,
    /** When provided, a forge-api.mjs CLI with baked-in config is added to the zip root. */
    projectApiKey?: string,
): Promise<{ buffer: Buffer; skillCount: number }> {
    // Fetch skills — global ones + project-specific ones
    const filters: any = {};
    if (projectDocumentId) {
        filters.$or = [
            { isGlobal: true },
            { project: { documentId: projectDocumentId } },
        ];
    } else {
        filters.isGlobal = true;
    }

    const skills = await strapi.documents('api::skill.skill').findMany({
        filters,
        fields: ['name', 'description', 'skillMd', 'files', 'target'],
        limit: 100,
    });

    // Include all skills — Antigravity runs pipeline skills (forge-triage, forge-code, etc.)
    // which are typically target=dev, plus any cloud/all skills
    const cloudSkills = skills;

    // Build zip using Node's built-in zlib + manual zip construction
    const entries: Array<{ path: string; data: Buffer; compressed: Buffer; crc: number }> = [];

    for (const skill of cloudSkills) {
        const skillName = skill.name || 'unknown';

        // Add SKILL.md
        if (skill.skillMd) {
            const data = Buffer.from(skill.skillMd, 'utf-8');
            const entry = await zipEntry(`skills/${skillName}/SKILL.md`, data);
            entries.push(entry);
        }

        // Add reference files from the files JSON array
        // Skip forge-api.mjs from antigravity-guide — we generate it at the zip root instead
        const files: Array<{ path: string; content: string; encoding?: string }> = skill.files || [];
        for (const file of files) {
            if (skillName === 'antigravity-guide' && file.path === 'references/forge-api.mjs') continue;
            const data = file.encoding === 'base64'
                ? Buffer.from(file.content, 'base64')
                : Buffer.from(file.content, 'utf-8');
            const entry = await zipEntry(`skills/${skillName}/${file.path}`, data);
            entries.push(entry);
        }
    }

    // Generate forge-api.mjs at zip root with baked-in project config
    if (projectApiKey) {
        const baseUrl = process.env.FORGE_PUBLIC_URL || 'http://localhost:1337';
        const cliSource = generateForgeCli(`${baseUrl}/api`, projectApiKey);
        const cliEntry = await zipEntry('forge-api.mjs', Buffer.from(cliSource, 'utf-8'));
        entries.push(cliEntry);
    }

    // Assemble zip file
    const zipBuffer = assembleZip(entries);
    return { buffer: zipBuffer, skillCount: cloudSkills.length };
}
