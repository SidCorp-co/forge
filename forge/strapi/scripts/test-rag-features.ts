/**
 * Test ISS-177→181 RAG features accuracy.
 */
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import { getQdrantClient } from '../src/services/embeddings/qdrant';
import { extractEntities, searchByEntities } from '../src/services/entity-index';
import { classifyIntent } from '../src/services/query-intent';
import { multiStrategySearch } from '../src/services/embeddings/multi-search';
import { formatRagEntries } from '../src/services/rag-formatter';
import { isRollingStatsFresh } from '../src/services/rolling-summary';
import type { RelevantContextEntry } from '../src/services/agent/system-prompt';

const STRAPI_URL = process.env.BACKFILL_STRAPI_URL || 'http://localhost:1337/api';
const API_KEY = process.env.BACKFILL_API_KEY;
if (!API_KEY) throw new Error('BACKFILL_API_KEY env var required');

async function apiGet(urlPath: string): Promise<any> {
  const resp = await fetch(`${STRAPI_URL}${urlPath}`, {
    headers: { 'X-Forge-API-Key': API_KEY },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

// Minimal strapi mock for classifyIntent
const mockStrapi = {
  log: {
    info: (...args: any[]) => console.log('[strapi]', ...args),
    warn: (...args: any[]) => console.warn('[strapi]', ...args),
    error: (...args: any[]) => console.error('[strapi]', ...args),
  },
  documents: (uid: string) => ({
    findMany: async (opts: any) => {
      // Map uid to REST endpoint: api::issue.issue → /issues
      const singular = uid.split('.').pop() || '';
      const endpoint = `/${singular}s`;
      // Build filters query string
      let qs = '';
      if (opts.filters?.project?.documentId) {
        qs += `filters[project][documentId][$eq]=${opts.filters.project.documentId}&`;
      }
      if (opts.filters?.$or) {
        opts.filters.$or.forEach((f: any, i: number) => {
          if (f.title?.$containsi) {
            qs += `filters[$or][${i}][title][$containsi]=${encodeURIComponent(f.title.$containsi)}&`;
          }
        });
      }
      qs += `pagination[pageSize]=${opts.limit || 25}`;
      const resp = await apiGet(`${endpoint}?${qs}`);
      return resp.data || [];
    },
  }),
};

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

async function run() {
  console.log('\n=== TEST 1: Entity Extraction ===');
  {
    const entities = extractEntities('Fix loginPage component path src/api/users');
    assert('Extracts camelCase', entities.includes('login'));
    assert('Extracts camelCase (page)', entities.includes('page'));
    assert('Extracts path segment (api)', entities.includes('api'));
    assert('Extracts path segment (users)', entities.includes('users'));
    assert('Filters stopwords (the)', !entities.includes('the'));
    assert('Has reasonable count', entities.length >= 4 && entities.length <= 20, `got ${entities.length}`);
    console.log(`  Entities: [${entities.join(', ')}]`);
  }

  console.log('\n=== TEST 2: Qdrant Entity Payload ===');
  {
    const qdrant = getQdrantClient();
    if (qdrant) {
      const result = await qdrant.scroll('forge_embeddings', {
        limit: 5, with_payload: true, with_vector: false,
      });
      const withEntities = result.points.filter((p: any) => Array.isArray(p.payload?.entities) && p.payload.entities.length > 0);
      assert('Qdrant points have entities', withEntities.length > 0, `${withEntities.length}/5 have entities`);
      if (withEntities.length > 0) {
        const sample = (withEntities[0].payload as any).entities.slice(0, 8);
        console.log(`  Sample entities: [${sample.join(', ')}]`);
      }
    } else {
      console.log('  [skip] Qdrant not available');
    }
  }

  console.log('\n=== TEST 3: Entity Search ===');
  {
    // Get a project ID
    const projects = await apiGet('/projects');
    const project = projects.data[0];
    const projectId = project.documentId;

    const results = await searchByEntities(projectId, ['login', 'page', 'auth']);
    assert('Entity search returns results', results.length > 0, `got ${results.length}`);
    if (results.length > 0) {
      assert('Results have proportional score (0.50-0.90)', results[0].score >= 0.50 && results[0].score <= 0.90);
      assert('Results have payload', !!results[0].payload.source_type);
    }
  }

  console.log('\n=== TEST 4: Rolling Stats ===');
  {
    const projects = await apiGet('/projects');
    const project = projects.data[0];
    const stats = project.rollingStats;
    assert('Rolling stats exist', !!stats);
    assert('Has totalIssues', typeof stats?.totalIssues === 'number');
    assert('Has statusCounts', !!stats?.statusCounts);
    assert('Has updatedAt', !!stats?.updatedAt);
    assert('Stats are fresh', isRollingStatsFresh(stats));
    if (stats) {
      console.log(`  Total: ${stats.totalIssues}, Blockers: ${stats.blockers?.length || 0}, Stale: ${stats.stale?.length || 0}`);
      console.log(`  Status: ${JSON.stringify(stats.statusCounts)}`);
    }
  }

  console.log('\n=== TEST 5: Intent Classification ===');
  {
    const tests: [string, string][] = [
      ['hello', 'CHAT'],
      ['thanks!', 'CHAT'],
      ['any pagination issues?', 'SEARCH'],
      ['project status?', 'SUMMARY'],
      ['how many bugs are open?', 'SUMMARY'],
      ['create an issue for login page', 'CREATE'],
      ['show me all critical bugs', 'LOOKUP'],
      ['list high priority features', 'LOOKUP'],
    ];
    for (const [msg, expected] of tests) {
      const { intent } = await classifyIntent(mockStrapi as any, msg);
      assert(`"${msg}" → ${expected}`, intent === expected, `got ${intent}`);
    }
  }

  console.log('\n=== TEST 5b: Query Condenser ===');
  {
    const { condenseQuery } = await import('../src/services/query-condenser');

    // No history → no condensation
    const r1 = await condenseQuery(mockStrapi as any, 'tell me about it', []);
    assert('No history → not condensed', !r1.wasCondensed);
    assert('No history → original returned', r1.standaloneQuestion === 'tell me about it');

    // Self-contained with history → LLM decides (should return unchanged)
    const r2 = await condenseQuery(mockStrapi as any, 'show me all open bugs', [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'Hi!' },
    ]);
    assert('Self-contained → LLM returns similar', r2.standaloneQuestion.toLowerCase().includes('open bugs'));
  }

  console.log('\n=== TEST 6: Multi-Strategy Search ===');
  {
    const projects = await apiGet('/projects');
    const projectId = projects.data[0].documentId;

    const { results, breakdown } = await multiStrategySearch(
      mockStrapi, projectId, 'login authentication issue', 20,
    );
    assert('Multi-search returns results', results.length > 0, `got ${results.length}`);
    assert('Has breakdown', typeof breakdown.entity === 'number');
    console.log(`  Breakdown: entity=${breakdown.entity}, vector=${breakdown.vector}, bm25=${breakdown.bm25}`);
    console.log(`  Total merged: ${results.length}`);
    if (results.length > 0) {
      console.log(`  Top result: score=${results[0].score.toFixed(3)}, type=${results[0].payload.source_type}`);
    }
  }

  console.log('\n=== TEST 7: RAG Formatter ===');
  {
    const entries: RelevantContextEntry[] = [
      {
        sourceType: 'issue',
        sourceId: 'abc123',
        text: 'Fix login page redirect loop\n\nWhen users login they get stuck in a redirect loop',
        score: 0.9,
        metadata: { title: 'Fix login page redirect loop', status: 'open', priority: 'high', issueId: 42 },
      },
      {
        sourceType: 'comment',
        sourceId: 'def456',
        text: 'I reproduced this on Chrome 120',
        score: 0.7,
        metadata: { issueTitle: 'Fix login page redirect loop' },
      },
      {
        sourceType: 'skill',
        sourceId: 'ghi789',
        text: 'Bug Report Template for consistent bug filing',
        score: 0.6,
        metadata: { name: 'Bug Report' },
      },
    ];
    const formatted = formatRagEntries(entries);
    assert('Formats issues with ID', formatted[0].text.includes('ISS-42'));
    assert('Formats issues with status', formatted[0].text.includes('[open, high]'));
    assert('Formats comments with issue title', formatted[1].text.includes('Fix login page redirect loop'));
    assert('Formats skills with name', formatted[2].text.includes('Skill Bug Report'));
    console.log(`  Issue formatted: ${formatted[0].text.slice(0, 100)}...`);
    console.log(`  Comment formatted: ${formatted[1].text.slice(0, 100)}`);
    console.log(`  Skill formatted: ${formatted[2].text.slice(0, 100)}`);
  }

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
