/**
 * Backfill embeddings using the running Strapi instance + direct embedding calls.
 * Reads data from Strapi REST API, embeds via the embeddings service directly.
 *
 * Usage: npx ts-node scripts/backfill-http.ts [--project <slug>]
 */

import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import { upsertEmbedding, sanitizeContent } from '../src/services/embeddings/index';
import { ensureQdrantCollection } from '../src/services/embeddings/qdrant';
import { enrichEntitiesWithLLM } from '../src/services/entity-index/index';

const STRAPI_URL = process.env.BACKFILL_STRAPI_URL || 'http://localhost:1337/api';
const API_KEY = process.env.BACKFILL_API_KEY;
if (!API_KEY) throw new Error('BACKFILL_API_KEY env var required');
const BEARER_TOKEN = process.env.BACKFILL_BEARER_TOKEN || '';
const BATCH_DELAY_MS = 500;
const LLM_DELAY_MS = 500;
const MIN_TEXT_LENGTH = 50;
const skipLLM = process.argv.includes('--skip-llm');

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function apiGet(urlPath: string): Promise<any> {
  const headers: Record<string, string> = BEARER_TOKEN
    ? { 'Authorization': `Bearer ${BEARER_TOKEN}` }
    : { 'X-Forge-API-Key': API_KEY };
  const resp = await fetch(`${STRAPI_URL}${urlPath}`, { headers });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

async function fetchAll(endpoint: string, filters = ''): Promise<any[]> {
  const all: any[] = [];
  let page = 1;
  while (true) {
    const sep = filters ? '&' : '';
    const resp = await apiGet(
      `${endpoint}?pagination[pageSize]=100&pagination[page]=${page}${sep}${filters}`,
    );
    const data = resp.data || [];
    all.push(...data);
    const { pageCount = 1 } = resp.meta?.pagination || {};
    if (page >= pageCount) break;
    page++;
  }
  return all;
}

async function run() {
  const slugArg = process.argv.indexOf('--project');
  const targetSlug = slugArg !== -1 ? process.argv[slugArg + 1] : undefined;

  console.log('[backfill] Ensuring Qdrant collection...');
  await ensureQdrantCollection();

  console.log('[backfill] Fetching projects...');
  const allProjects = await fetchAll('/projects');
  const filtered = targetSlug ? allProjects.filter((p: any) => p.slug === targetSlug) : allProjects;
  console.log(`[backfill] Processing ${filtered.length} project(s)...`);

  for (const project of filtered) {
    const projectId = project.documentId;
    console.log(`\n=== ${project.name} (${project.slug}) ===`);

    // Issues
    const issues = await fetchAll(
      '/issues',
      `filters[project][documentId][$eq]=${projectId}`
    );
    let embedded = 0;
    for (const issue of issues) {
      const text = sanitizeContent(
        [issue.title, issue.description, issue.acceptanceCriteria]
          .filter(Boolean)
          .join('\n\n')
      );
      if (text.length < MIN_TEXT_LENGTH) continue;
      try {
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
            updatedAt: issue.updatedAt || issue.createdAt,
          },
        });
        embedded++;
        if (!skipLLM && text.length >= MIN_TEXT_LENGTH) {
          try {
            await enrichEntitiesWithLLM(projectId, 'issue', issue.documentId, text);
            await sleep(LLM_DELAY_MS);
          } catch (llmErr: any) {
            console.error(`  [llm-enrich] issue ${issue.documentId}: ${llmErr.message}`);
          }
        }
      } catch (err: any) {
        console.error(`  [error] issue ${issue.documentId}: ${err.message}`);
      }
    }
    console.log(`  Issues: ${embedded}/${issues.length} embedded${skipLLM ? '' : ' + LLM enriched'}`);
    await sleep(BATCH_DELAY_MS);

    // Comments (need issue populated for context)
    const comments = await fetchAll(
      '/comments',
      `filters[issue][project][documentId][$eq]=${projectId}&populate=issue`
    );
    let commentEmbedded = 0;
    for (const comment of comments) {
      const issueTitle = comment.issue?.title || '';
      const text = sanitizeContent(`[${issueTitle}]\n\n${comment.body || ''}`);
      if (text.length < MIN_TEXT_LENGTH) continue;
      try {
        await upsertEmbedding({
          project_id: projectId,
          source_type: 'comment',
          source_id: comment.documentId,
          text,
          metadata: {
            issueDocId: comment.issue?.documentId,
            issueTitle: comment.issue?.title,
            issueStatus: comment.issue?.status,
            issueCategory: comment.issue?.category,
            author: comment.author,
            updatedAt: comment.updatedAt || comment.createdAt,
          },
        });
        commentEmbedded++;
      } catch (err: any) {
        console.error(`  [error] comment ${comment.documentId}: ${err.message}`);
      }
    }
    console.log(`  Comments: ${commentEmbedded}/${comments.length} embedded`);
    await sleep(BATCH_DELAY_MS);

    // Skills — embed project-scoped AND global skills for this project
    let skillEmbedded = 0;
    try {
      let skills: any[];
      skills = await fetchAll('/skills');
      for (const skill of skills) {
        // Only embed cloud-targeted skills (used by web chat agent)
        if (skill.target !== 'cloud') continue;
        // Only embed global skills or skills belonging to this project
        const skillProjectId = skill.project?.documentId;
        if (skillProjectId && skillProjectId !== projectId) continue;

        const text = sanitizeContent(
          [skill.name, skill.description, skill.skillMd].filter(Boolean).join('\n\n')
        );
        if (text.length < MIN_TEXT_LENGTH) continue;
        try {
          await upsertEmbedding({
            project_id: projectId,
            source_type: 'skill',
            source_id: skill.documentId,
            text,
            metadata: {
              title: skill.name,
              version: skill.version,
              updatedAt: skill.updatedAt || skill.createdAt,
            },
          });
          skillEmbedded++;
        } catch (err: any) {
          console.error(`  [error] skill ${skill.documentId}: ${err.message}`);
        }
      }
    } catch (err: any) {
      console.warn(`  [warn] Skills fetch failed (${err.message}) — skipping`);
    }
    console.log(`  Skills: ${skillEmbedded} embedded`);
    await sleep(BATCH_DELAY_MS);

    // Rolling stats — recompute via direct import
    console.log(`  Recomputing rolling stats via API...`);
    try {
      // Rolling stats are computed server-side; trigger via a dummy project update
      // that causes the lifecycle to fire. Instead, compute locally and PUT.
      const statusCounts: Record<string, number> = {};
      const priorityCounts: Record<string, number> = {};
      const categoryCounts: Record<string, number> = {};
      const blockers: any[] = [];
      const stale: any[] = [];
      const now = Date.now();
      const thirtyDays = 30 * 24 * 60 * 60 * 1000;

      for (const issue of issues) {
        const s = issue.status || 'unknown';
        statusCounts[s] = (statusCounts[s] || 0) + 1;
        const p = issue.priority || 'unknown';
        priorityCounts[p] = (priorityCounts[p] || 0) + 1;
        const c = issue.category || 'unknown';
        categoryCounts[c] = (categoryCounts[c] || 0) + 1;

        if (
          (issue.priority === 'critical' || issue.priority === 'high') &&
          ['in_progress', 'approved', 'open'].includes(issue.status)
        ) {
          blockers.push({ documentId: issue.documentId, title: issue.title, status: issue.status, priority: issue.priority });
        }

        const age = now - new Date(issue.updatedAt || issue.createdAt).getTime();
        if (age > thirtyDays && !['closed', 'released', 'confirmed'].includes(issue.status)) {
          stale.push({ documentId: issue.documentId, title: issue.title, status: issue.status, daysSinceUpdate: Math.floor(age / (24 * 60 * 60 * 1000)) });
        }
      }

      const rollingStats = {
        totalIssues: issues.length,
        statusCounts,
        priorityCounts,
        categoryCounts,
        blockers: blockers.slice(0, 10),
        stale: stale.slice(0, 10),
        updatedAt: new Date().toISOString(),
      };

      // Update project with rolling stats via API
      const headers: Record<string, string> = BEARER_TOKEN
        ? { 'Authorization': `Bearer ${BEARER_TOKEN}`, 'Content-Type': 'application/json' }
        : { 'X-Forge-API-Key': API_KEY, 'Content-Type': 'application/json' };
      const putResp = await fetch(`${STRAPI_URL}/projects/${project.documentId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ data: { rollingStats } }),
      });
      if (putResp.ok) {
        console.log(`  Rolling stats: ${issues.length} issues → ${Object.keys(statusCounts).length} statuses, ${blockers.length} blockers, ${stale.length} stale`);
      } else {
        console.warn(`  [warn] Rolling stats PUT failed: ${putResp.status}`);
      }
    } catch (err: any) {
      console.warn(`  [warn] Rolling stats failed: ${err.message}`);
    }
  }

  console.log('\n[backfill] Done!');
}

run().catch((err) => {
  console.error('[backfill] Fatal:', err);
  process.exit(1);
});
