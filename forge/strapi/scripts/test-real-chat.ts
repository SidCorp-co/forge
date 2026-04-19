/**
 * Test RAG pipeline + system prompt with real production user queries.
 * Validates: query condensation, intent classification, RAG routing,
 * system prompt strategy hints, and multi-turn conversation flows.
 *
 * Assertions focus on what matters: correct intent, good topic resolution,
 * correct RAG routing, and strategy exclusivity. Condensation behavior
 * is observed but not strictly asserted (heuristic-dependent).
 */
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import { sanitizeContent } from '../src/services/embeddings/index';
import { rerank } from '../src/services/embeddings/reranker';
import { multiStrategySearch } from '../src/services/embeddings/multi-search';
import { classifyIntent } from '../src/services/query-intent';
import type { QueryIntent } from '../src/services/query-intent';
import { condenseQuery } from '../src/services/query-condenser';
import { formatRagEntries } from '../src/services/rag-formatter';
import { isRollingStatsFresh } from '../src/services/rolling-summary';
import { buildSystemPrompt } from '../src/services/agent/system-prompt';
import type { RelevantContextEntry, PromptContext } from '../src/services/agent/system-prompt';

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

const mockStrapi: any = {
  log: {
    info: (...args: any[]) => console.log('  [log]', ...args),
    warn: (...args: any[]) => {},
    error: (...args: any[]) => console.error('  [err]', ...args),
  },
  documents: (uid: string) => ({
    findMany: async (opts: any) => {
      const singular = uid.split('.').pop() || '';
      const endpoint = `/${singular}s`;
      let qs = '';
      if (opts.filters?.project?.documentId) {
        qs += `filters%5Bproject%5D%5BdocumentId%5D%5B%24eq%5D=${opts.filters.project.documentId}&`;
      }
      if (opts.filters?.$or) {
        opts.filters.$or.forEach((f: any, i: number) => {
          if (f.title?.$containsi) {
            qs += `filters%5B%24or%5D%5B${i}%5D%5Btitle%5D%5B%24containsi%5D=${encodeURIComponent(f.title.$containsi)}&`;
          }
        });
      }
      qs += `pagination%5BpageSize%5D=${opts.limit || 25}`;
      const resp = await apiGet(`${endpoint}?${qs}`);
      return resp.data || [];
    },
  }),
};

interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

interface PipelineResult {
  intent: QueryIntent;
  standaloneQuestion: string;
  wasCondensed: boolean;
  ragCount: number;
  entries: RelevantContextEntry[];
  breakdown?: { entity: number; vector: number; fulltext: number };
  usedRollingStats: boolean;
  systemPrompt: string;
}

async function simulateFullPipeline(
  project: any,
  query: string,
  history: ConversationTurn[] = [],
): Promise<PipelineResult> {
  const rawQuery = query.replace(/ISS-\d+/g, '').trim();
  const { standaloneQuestion, wasCondensed } = await condenseQuery(mockStrapi, rawQuery, history);
  const { intent } = await classifyIntent(mockStrapi, standaloneQuestion);
  const searchQuery = standaloneQuestion;

  let entries: RelevantContextEntry[] = [];
  let breakdown: any;
  let usedRollingStats = false;

  if (intent === 'CHAT' || intent === 'LOOKUP') {
    // No RAG
  } else if (intent === 'CREATE') {
    const { results } = await multiStrategySearch(mockStrapi, project.documentId, searchQuery, 5, ['skill']);
    entries = formatRagEntries(results.slice(0, 3).map((r) => ({
      sourceType: r.payload.source_type, sourceId: r.payload.source_id,
      text: sanitizeContent(r.payload.text), score: r.score, metadata: r.payload.metadata,
    })));
  } else if (intent === 'SUMMARY' && isRollingStatsFresh(project.rollingStats)) {
    usedRollingStats = true;
  } else {
    const { results: raw, breakdown: bd } = await multiStrategySearch(mockStrapi, project.documentId, searchQuery, 20);
    breakdown = bd;
    const ranked = rerank(raw, searchQuery, 8);
    entries = formatRagEntries(ranked.slice(0, 8).map((r) => ({
      sourceType: r.payload.source_type, sourceId: r.payload.source_id,
      text: sanitizeContent(r.payload.text), score: (r as any).finalScore || r.score, metadata: r.payload.metadata,
    })));
  }

  const promptCtx: PromptContext = {
    projectName: project.name || project.slug,
    projectDescription: project.description,
    agentPrompt: project.agentPrompt,
    rollingStats: project.rollingStats,
    userKey: 'test-user', sessionSource: 'web', model: 'test',
    tools: [], relevantContext: entries, queryIntent: intent,
  };
  const systemPrompt = buildSystemPrompt(promptCtx);

  return { intent, standaloneQuestion: searchQuery, wasCondensed, ragCount: entries.length, entries, breakdown, usedRollingStats, systemPrompt };
}

// ═══════════════════════════════════════════════════════════
// Test runner
// ═══════════════════════════════════════════════════════════

let totalPassed = 0;
let totalFailed = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    totalPassed++;
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    totalFailed++;
  }
}

// Strategy names expected per intent
const STRATEGY_MAP: Record<QueryIntent, string> = {
  SEARCH: 'Semantic Search',
  LOOKUP: 'Filtered Lookup',
  CREATE: 'Issue Creation',
  SUMMARY: 'Project Summary',
  CHAT: 'Conversation',
  ACTION: 'Direct Action',
};

function checkStrategyExclusivity(r: PipelineResult) {
  const expected = STRATEGY_MAP[r.intent];
  if (!expected) return;
  const strategies = Object.values(STRATEGY_MAP);
  const active = strategies.filter((s) => r.systemPrompt.includes(`Query Strategy: ${s}`));
  check(`Strategy: ${expected}`, active.includes(expected), `got ${active.join(', ') || 'none'}`);
  check('No extra strategies', active.length <= 1, active.length > 1 ? `has: ${active.join(', ')}` : undefined);
}

function checkRagSanity(r: PipelineResult) {
  if (r.intent === 'CHAT' || r.intent === 'LOOKUP') {
    check(`No RAG for ${r.intent}`, r.ragCount === 0, `got ${r.ragCount}`);
  }
  if (r.intent === 'CREATE') {
    check('Only skill results for CREATE', r.entries.every((e) => e.sourceType === 'skill'));
  }
}

// ═══════════════════════════════════════════════════════════
// PART 1: Single-turn smoke tests
// ═══════════════════════════════════════════════════════════

const SMOKE_TESTS: { query: string; slug: string; intent: QueryIntent; extraChecks?: (r: PipelineResult) => void }[] = [
  { query: 'hello', slug: 'forge-agents', intent: 'CHAT' },
  { query: 'thanks!', slug: 'forge-agents', intent: 'CHAT' },
  { query: 'project status?', slug: 'forge-agents', intent: 'SUMMARY' },
  { query: 'how many bugs are open?', slug: 'forge-agents', intent: 'SUMMARY' },
  { query: 'what are the critical priority issues?', slug: 'forge-agents', intent: 'LOOKUP' },
  { query: 'show me all open bugs', slug: 'forge-agents', intent: 'LOOKUP' },
  { query: 'any pagination issues?', slug: 'forge-agents', intent: 'SEARCH',
    extraChecks: (r) => { check('Has RAG results', r.ragCount > 0); } },
  { query: 'Sentry integration', slug: 'forge-agents', intent: 'SEARCH',
    extraChecks: (r) => { check('Has RAG results', r.ragCount > 0); } },
  { query: 'create an issue for login page bug', slug: 'forge-agents', intent: 'CREATE' },
  { query: 'tạo issue cho trang đăng nhập', slug: 'hrm', intent: 'CREATE' },
  { query: 'hiện tất cả issue đang mở', slug: 'hrm', intent: 'LOOKUP' },
];

// ═══════════════════════════════════════════════════════════
// PART 2: Multi-turn conversation flows
// ═══════════════════════════════════════════════════════════

interface FlowTurn {
  user: string;
  assistant?: string;
  intent: QueryIntent;
  /** If condensed, standalone question should contain one of these keywords */
  topicKeywords?: string[];
}

interface Flow {
  name: string;
  slug: string;
  turns: FlowTurn[];
}

const FLOWS: Flow[] = [
  {
    name: 'Bug Investigation (EN)',
    slug: 'forge-agents',
    turns: [
      { user: 'show me open bugs', intent: 'LOOKUP',
        assistant: 'Open bugs: ISS-42 Login redirect, ISS-55 Pagination broken, ISS-67 WS disconnect' },
      { user: 'tell me more about the pagination one', intent: 'SEARCH', topicKeywords: ['pagination'],
        assistant: 'ISS-55: Pagination broken on mobile.' },
      { user: 'is it related to the mobile layout?', intent: 'SEARCH', topicKeywords: ['pagination', 'mobile', 'layout'],
        assistant: 'Yes, uses fixed widths.' },
      { user: 'create a fix for it', intent: 'CREATE' },
      { user: 'thanks', intent: 'CHAT' },
    ],
  },
  {
    name: 'Summary → Drill-down (EN)',
    slug: 'forge-agents',
    turns: [
      { user: 'how is the project doing?', intent: 'SUMMARY',
        assistant: '45 issues, 12 open, 8 in progress, 25 closed. 3 critical blockers.' },
      { user: 'show me critical bugs', intent: 'LOOKUP',
        assistant: 'ISS-12 Auth crash, ISS-34 Data loss.' },
      { user: 'what about ISS-12?', intent: 'SEARCH' },
      { user: 'ok thanks', intent: 'CHAT' },
    ],
  },
  {
    name: 'Vietnamese Full Workflow',
    slug: 'hrm',
    turns: [
      { user: 'vấn đề chấm công', intent: 'SEARCH',
        assistant: 'Attendance Report, Chấm công bị lỗi' },
      { user: 'cái đầu tiên, cho xem thêm', intent: 'SEARCH', topicKeywords: ['attendance', 'chấm'] },
      { user: 'tạo issue cho vấn đề đó', intent: 'CREATE', topicKeywords: ['attendance', 'chấm'] },
      { user: 'ok cảm ơn', intent: 'CHAT' },
    ],
  },
  {
    name: 'Mixed EN+VI',
    slug: 'forge-agents',
    turns: [
      { user: 'login page issues', intent: 'SEARCH',
        assistant: 'ISS-42 Login redirect, ISS-88 Login validation' },
      { user: 'cái đó có nghiêm trọng không?', intent: 'SEARCH', topicKeywords: ['login'] },
      { user: 'create an issue để fix nó', intent: 'CREATE' },
    ],
  },
  {
    name: 'Topic Switch (EN)',
    slug: 'forge-agents',
    turns: [
      { user: 'authentication bugs', intent: 'SEARCH',
        assistant: 'ISS-12 Auth crash, ISS-42 Login redirect' },
      { user: 'tell me more', intent: 'SEARCH', topicKeywords: ['auth', 'login'],
        assistant: 'ISS-12 crashes when JWT expires' },
      { user: 'what about pagination?', intent: 'SEARCH',
        assistant: 'ISS-55 Pagination broken on mobile' },
      { user: 'any relation to that auth bug?', intent: 'SEARCH', topicKeywords: ['auth', 'pagination'] },
    ],
  },
  {
    name: 'Short Follow-ups (EN)',
    slug: 'forge-agents',
    turns: [
      { user: 'WebSocket reconnect issues', intent: 'SEARCH',
        assistant: 'ISS-67 WS disconnect, ISS-78 Reconnect loop' },
      { user: 'any more?', intent: 'SEARCH', topicKeywords: ['websocket', 'ws', 'reconnect'] },
      { user: 'status?', intent: 'SEARCH', topicKeywords: ['websocket', 'ws', 'disconnect', 'reconnect'] },
    ],
  },
  {
    name: 'Rapid Intent Switching (EN)',
    slug: 'forge-agents',
    turns: [
      { user: 'hello', intent: 'CHAT', assistant: 'Hi! How can I help?' },
      { user: 'what issues are open?', intent: 'LOOKUP', assistant: '12 open issues' },
      { user: 'find pagination bugs', intent: 'SEARCH', assistant: 'ISS-55 Pagination broken' },
      { user: 'create a fix', intent: 'CREATE' },
      { user: 'done', intent: 'CHAT' },
    ],
  },
  {
    name: 'Create-heavy Flow (EN)',
    slug: 'forge-agents',
    turns: [
      { user: 'create an issue for rate limiting', intent: 'CREATE',
        assistant: 'Created ISS-100: Rate limiting' },
      { user: 'also create one for timeout', intent: 'CREATE' },
      { user: 'show me what we created', intent: 'LOOKUP' },
      { user: 'looks good', intent: 'CHAT' },
    ],
  },
  {
    name: 'Deep Chain (EN, 7 turns)',
    slug: 'forge-agents',
    turns: [
      { user: 'database performance issues', intent: 'SEARCH',
        assistant: 'ISS-45 Slow query, ISS-72 N+1 queries' },
      { user: 'the first one, more details?', intent: 'SEARCH', topicKeywords: ['45', 'slow', 'query'],
        assistant: 'ISS-45: Full table scan on issue list' },
      { user: 'any indexing issues related?', intent: 'SEARCH', topicKeywords: ['index', 'database', '45'],
        assistant: 'ISS-73 Missing indexes' },
      { user: 'show all performance bugs', intent: 'LOOKUP',
        assistant: 'ISS-45, ISS-72, ISS-73, ISS-80' },
      { user: 'which are stale?', intent: 'LOOKUP',
        assistant: 'ISS-45 and ISS-72 are 30+ days old' },
      { user: 'create cleanup task for those', intent: 'CREATE', topicKeywords: ['45', '72', 'stale', 'cleanup'] },
      { user: 'thanks for the help', intent: 'CHAT' },
    ],
  },
  {
    name: 'HRM Domain (VI)',
    slug: 'hrm',
    turns: [
      { user: 'báo cáo nghỉ phép', intent: 'SEARCH',
        assistant: 'Leave Report — báo cáo nghỉ phép' },
      { user: 'vấn đề export có liên quan không?', intent: 'SEARCH', topicKeywords: ['export', 'nghỉ', 'leave'] },
      { user: 'thêm bug cho trang xuất dữ liệu', intent: 'CREATE' },
      { user: 'xong rồi', intent: 'CHAT' },
    ],
  },
  {
    name: 'Negation & Clarification (EN)',
    slug: 'forge-agents',
    turns: [
      { user: 'issues about authentication', intent: 'SEARCH',
        assistant: 'ISS-12 Auth token, ISS-30 Session management' },
      { user: 'no, not auth — I meant the session management one', intent: 'SEARCH', topicKeywords: ['session'] },
      { user: 'create an issue for session timeout', intent: 'CREATE' },
    ],
  },
  {
    name: 'Code Reference (EN)',
    slug: 'forge-agents',
    turns: [
      { user: 'issues with loginUser() function', intent: 'SEARCH',
        assistant: 'ISS-42 Login redirect — involves loginUser()' },
      { user: 'what about the related validateToken middleware?', intent: 'SEARCH', topicKeywords: ['validatetoken', 'token', 'middleware'] },
      { user: 'create a refactoring issue for both', intent: 'CREATE' },
    ],
  },
  {
    name: 'Summary then Explore (EN)',
    slug: 'forge-agents',
    turns: [
      { user: 'how many bugs are open?', intent: 'SUMMARY',
        assistant: '12 open bugs' },
      { user: 'list them all', intent: 'LOOKUP',
        assistant: 'ISS-42, ISS-55, ISS-67...' },
      { user: "what's the priority breakdown?", intent: 'SUMMARY' },
    ],
  },
  {
    name: 'First-time User Onboarding (EN)',
    slug: 'forge-agents',
    turns: [
      { user: "hi, I'm new here", intent: 'CHAT',
        assistant: 'Welcome! Ask about issues, status, or create new ones.' },
      { user: 'what issues are open?', intent: 'LOOKUP',
        assistant: '12 open issues across various priorities' },
      { user: "anything beginner-friendly?", intent: 'SEARCH' },
    ],
  },
  {
    name: 'Long Conversation Stability (EN)',
    slug: 'forge-agents',
    turns: [
      { user: 'Sentry integration issues', intent: 'SEARCH',
        assistant: 'ISS-89: Sentry MCP integration' },
      { user: 'related issues?', intent: 'SEARCH', topicKeywords: ['sentry'],
        assistant: 'ISS-92: Error tracking dashboard' },
      { user: 'overall project status?', intent: 'SUMMARY',
        assistant: '45 issues total' },
      { user: 'show me all high priority', intent: 'LOOKUP' },
      { user: 'thanks', intent: 'CHAT' },
    ],
  },
];

async function run() {
  const projectsResp = await apiGet('/projects');
  const projectMap = new Map<string, any>();
  for (const p of projectsResp.data) projectMap.set(p.slug, p);

  // ─── PART 1 ───
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  PART 1: Single-turn Smoke Tests                       ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  for (const tc of SMOKE_TESTS) {
    const project = projectMap.get(tc.slug);
    if (!project) { console.log(`\n[SKIP] "${tc.query}" — project ${tc.slug} not found`); continue; }
    console.log(`\n─── "${tc.query}" (${tc.slug}) ───`);

    try {
      const r = await simulateFullPipeline(project, tc.query);
      check(`Intent: ${r.intent}`, r.intent === tc.intent,
        r.intent !== tc.intent ? `expected ${tc.intent}` : undefined);
      checkStrategyExclusivity(r);
      checkRagSanity(r);
      if (tc.extraChecks) tc.extraChecks(r);
      if (r.ragCount > 0) console.log(`  → ${r.ragCount} RAG entries`);
    } catch (err: any) {
      console.log(`  ✗ ERROR: ${err.message}`);
      totalFailed++;
    }
  }

  // ─── PART 2 ───
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  PART 2: Multi-turn Conversation Flows (15 flows)      ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  for (const flow of FLOWS) {
    const project = projectMap.get(flow.slug);
    if (!project) { console.log(`\n[SKIP] "${flow.name}" — project ${flow.slug} not found`); continue; }
    console.log(`\n━━━ ${flow.name} (${flow.slug}) ━━━`);

    const history: ConversationTurn[] = [];

    for (let i = 0; i < flow.turns.length; i++) {
      const turn = flow.turns[i];
      console.log(`\n  Turn ${i + 1}: "${turn.user}"`);

      try {
        const r = await simulateFullPipeline(project, turn.user, history);

        // Core assertion: intent
        check(`Intent: ${r.intent}`, r.intent === turn.intent,
          r.intent !== turn.intent ? `expected ${turn.intent}, got ${r.intent}` : undefined);

        // Strategy & RAG sanity
        checkStrategyExclusivity(r);
        checkRagSanity(r);

        // Topic resolution: if condensed AND keywords specified, check resolution quality
        if (r.wasCondensed && turn.topicKeywords?.length) {
          const lower = r.standaloneQuestion.toLowerCase();
          const matched = turn.topicKeywords.some((kw) => lower.includes(kw.toLowerCase()));
          check(`Topic resolved: ${turn.topicKeywords.join('|')}`, matched,
            `standalone="${r.standaloneQuestion.slice(0, 80)}"`);
        }

        // Log condensation for observability
        if (r.wasCondensed) console.log(`    → Condensed: "${r.standaloneQuestion.slice(0, 80)}"`);
        if (r.ragCount > 0) console.log(`    → ${r.ragCount} RAG entries`);

        // Build history
        history.push({ role: 'user', content: turn.user });
        if (turn.assistant) history.push({ role: 'assistant', content: turn.assistant });
      } catch (err: any) {
        console.log(`    ✗ ERROR: ${err.message}`);
        totalFailed++;
        history.push({ role: 'user', content: turn.user });
        if (turn.assistant) history.push({ role: 'assistant', content: turn.assistant });
      }
    }
  }

  // ─── Results ───
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`TOTAL: ${totalPassed} passed, ${totalFailed} failed`);
  console.log(`${'═'.repeat(60)}\n`);
  process.exit(totalFailed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
