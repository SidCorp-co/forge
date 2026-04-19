/**
 * Backfill embeddings for existing Strapi content.
 *
 * Usage:
 *   npx ts-node forge/strapi/scripts/backfill-embeddings.ts [--project <slug>]
 *
 * Iterates all projects (or a specific --project) and embeds issues, comments, and skills.
 * Operations are idempotent — deterministic IDs ensure safe re-runs.
 */

import * as path from 'path';

// Resolve strapi root: works from both src/scripts/ and dist/scripts/
const strapiDir = __dirname.includes('dist')
  ? path.resolve(__dirname, '..', '..')
  : path.resolve(__dirname, '..');
process.chdir(strapiDir);

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('dotenv').config({ path: path.join(strapiDir, '.env') });

const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  return undefined;
}

async function processBatch<T>(
  items: T[],
  label: string,
  handler: (item: T) => Promise<void>
): Promise<{ processed: number; errors: number }> {
  let processed = 0;
  let errors = 0;
  for (const item of items) {
    try {
      await handler(item);
      processed++;
    } catch (err: any) {
      errors++;
      console.error(`  [error] Failed to embed ${label}: ${err.message}`);
    }
  }
  return { processed, errors };
}

async function run() {
  const targetSlug = getArg('--project');

  // Boot Strapi programmatically
  console.log('[backfill] Booting Strapi...');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createStrapi } = require('@strapi/strapi');
  const app = await createStrapi({ appDir: strapiDir }).load();

  // Import embedding service after Strapi boot (services resolve env at runtime)
  // We import directly from source since ts-node handles transpilation
  const { upsertEmbedding, sanitizeContent } = await import('../src/services/embeddings/index');
  const { enrichEntitiesWithLLM } = await import('../src/services/entity-index/index');
  const { recomputeRollingStats } = await import('../src/services/rolling-summary/index');
  const skipLLM = process.argv.includes('--skip-llm');
  const LLM_DELAY_MS = 500; // rate-limit LLM calls

  try {
    // Resolve projects
    let projects: any[] = await app.documents('api::project.project' as any).findMany({
      filters: targetSlug ? { slug: { $eq: targetSlug } } : {},
    });

    if (projects.length === 0) {
      console.log(
        targetSlug
          ? `[backfill] No project found with slug "${targetSlug}"`
          : '[backfill] No projects found'
      );
      return;
    }

    console.log(`[backfill] Processing ${projects.length} project(s)...`);

    for (const project of projects) {
      const { documentId: projectId, slug, name } = project;
      console.log(`\n[backfill] Project: ${name} (${slug})`);

      // ---- Issues ----
      const totalIssues: number = await app.documents('api::issue.issue' as any).count({
        filters: { project: { documentId: { $eq: projectId } } },
      });
      let issueOffset = 0;
      let issuesEmbedded = 0;

      while (issueOffset < totalIssues) {
        const issues: any[] = await app.documents('api::issue.issue' as any).findMany({
          filters: { project: { documentId: { $eq: projectId } } },
          start: issueOffset,
          limit: BATCH_SIZE,
        });

        const { processed } = await processBatch(issues, 'issue', async (issue) => {
          const text = sanitizeContent(
            [issue.title, issue.description, issue.acceptanceCriteria, issue.aiSummary]
              .filter(Boolean)
              .join('\n\n')
          );
          await upsertEmbedding({
            project_id: projectId,
            source_type: 'issue',
            source_id: issue.documentId,
            text,
            metadata: {
              title: issue.title,
              status: issue.status,
              priority: issue.priority,
              category: issue.category,
              issueId: issue.id,
              hasAC: Boolean(issue.acceptanceCriteria),
              suggestedSolution: issue.suggestedSolution ? String(issue.suggestedSolution).slice(0, 400) : undefined,
              acceptanceCriteria: issue.acceptanceCriteria ? String(issue.acceptanceCriteria).slice(0, 200) : undefined,
              updatedAt: issue.updatedAt,
            },
          });
          // LLM entity enrichment (merge with heuristic entities)
          if (!skipLLM && text) {
            try {
              await enrichEntitiesWithLLM(projectId, 'issue', issue.documentId, text);
              await sleep(LLM_DELAY_MS);
            } catch (err: any) {
              console.error(`  [llm-enrich] issue ${issue.documentId}: ${err.message}`);
            }
          }
        });

        issuesEmbedded += processed;
        issueOffset += BATCH_SIZE;
        console.log(`  Issues: ${Math.min(issueOffset, totalIssues)}/${totalIssues}`);
        if (issueOffset < totalIssues) await sleep(BATCH_DELAY_MS);
      }
      console.log(`  Embedded ${issuesEmbedded}/${totalIssues} issues`);

      // ---- Comments ----
      const totalComments: number = await app.documents('api::comment.comment' as any).count({
        filters: { issue: { project: { documentId: { $eq: projectId } } } },
      });
      let commentOffset = 0;
      let commentsEmbedded = 0;

      while (commentOffset < totalComments) {
        const comments: any[] = await app.documents('api::comment.comment' as any).findMany({
          filters: { issue: { project: { documentId: { $eq: projectId } } } },
          populate: ['issue'],
          start: commentOffset,
          limit: BATCH_SIZE,
        });

        const { processed } = await processBatch(comments, 'comment', async (comment) => {
          const text = sanitizeContent(comment.body ?? '');
          if (!text) return;
          await upsertEmbedding({
            project_id: projectId,
            source_type: 'comment',
            source_id: comment.documentId,
            text,
            metadata: {
              issueId: comment.issue?.documentId,
              updatedAt: comment.updatedAt,
            },
          });
        });

        commentsEmbedded += processed;
        commentOffset += BATCH_SIZE;
        console.log(`  Comments: ${Math.min(commentOffset, totalComments)}/${totalComments}`);
        if (commentOffset < totalComments) await sleep(BATCH_DELAY_MS);
      }
      console.log(`  Embedded ${commentsEmbedded}/${totalComments} comments`);

      // ---- Skills ----
      const skillFilters = project.isGlobal
        ? { isGlobal: { $eq: true } }
        : {
            $or: [
              { project: { documentId: { $eq: projectId } } },
              { isGlobal: { $eq: true } },
            ],
          };

      const totalSkills: number = await app.documents('api::skill.skill' as any).count({
        filters: skillFilters,
      });
      let skillOffset = 0;
      let skillsEmbedded = 0;

      while (skillOffset < totalSkills) {
        const skills: any[] = await app.documents('api::skill.skill' as any).findMany({
          filters: skillFilters,
          start: skillOffset,
          limit: BATCH_SIZE,
        });

        const { processed } = await processBatch(skills, 'skill', async (skill) => {
          const text = sanitizeContent(
            [skill.name, skill.description, skill.skillMd].filter(Boolean).join('\n\n')
          );
          if (!text) return;
          await upsertEmbedding({
            project_id: projectId,
            source_type: 'skill',
            source_id: skill.documentId,
            text,
            metadata: {
              name: skill.name,
              isGlobal: skill.isGlobal,
              updatedAt: skill.updatedAt,
            },
          });
        });

        skillsEmbedded += processed;
        skillOffset += BATCH_SIZE;
        console.log(`  Skills: ${Math.min(skillOffset, totalSkills)}/${totalSkills}`);
        if (skillOffset < totalSkills) await sleep(BATCH_DELAY_MS);
      }
      console.log(`  Embedded ${skillsEmbedded}/${totalSkills} skills`);

      // ---- Rolling Stats ----
      console.log(`  Recomputing rolling stats...`);
      await recomputeRollingStats(app, projectId);
      console.log(`  Rolling stats updated.`);
    }

    console.log('\n[backfill] Done.');
  } finally {
    await app.destroy();
  }
}

run().catch((err) => {
  console.error('[backfill] Fatal error:', err);
  process.exit(1);
});
