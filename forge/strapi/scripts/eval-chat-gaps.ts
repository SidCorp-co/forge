/**
 * Chat Gap Analyzer — Identifies knowledge and capability gaps from chat logs.
 *
 * Fetches chat logs for a project, analyzes patterns:
 *  - Failed/error turns
 *  - Low RAG hit turns (agent had no context)
 *  - Tool call failures
 *  - Unanswered queries (short/generic replies)
 *  - Intent distribution & unhandled intents
 *  - Repeated questions (knowledge gaps)
 *  - Slow turns (latency spikes)
 *
 * Usage:
 *   npx tsx scripts/eval-chat-gaps.ts --project portal-lh [--limit 200] [--days 30]
 */
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const STRAPI_URL = process.env.EVAL_STRAPI_URL || 'http://localhost:1337/api';
const API_KEY = process.env.EVAL_API_KEY || '';
const LITELLM_URL = process.env.LITELLM_API_URL;
const LITELLM_KEY = process.env.LITELLM_API_KEY;

let cachedJwt: string | null = null;
async function getAuthHeaders(): Promise<Record<string, string>> {
  const strapiUrl = process.env.EVAL_STRAPI_URL || STRAPI_URL;
  const apiKey = process.env.EVAL_API_KEY || API_KEY;
  const user = process.env.EVAL_STRAPI_USER || '';
  const pass = process.env.EVAL_STRAPI_PASS || '';

  // Try JWT auth first
  if (user && pass) {
    if (!cachedJwt) {
      const resp = await fetch(`${strapiUrl}/auth/local`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: user, password: pass }),
      });
      if (resp.ok) {
        const data = (await resp.json()) as any;
        cachedJwt = data.jwt;
      }
    }
    if (cachedJwt) return { Authorization: `Bearer ${cachedJwt}` };
  }
  // Fallback to API key
  if (apiKey) return { 'X-Forge-API-Key': apiKey };
  throw new Error('Set EVAL_STRAPI_USER+EVAL_STRAPI_PASS or EVAL_API_KEY for auth');
}

interface ChatLog {
  id: number;
  documentId: string;
  sessionId: string;
  projectSlug: string;
  userKey: string;
  query: string;
  reply: string | null;
  model: string | null;
  ragContext: any[] | null;
  toolCalls: any[] | null;
  usage: { inputTokens?: number; outputTokens?: number } | null;
  iterations: number | null;
  durationMs: number | null;
  error: string | null;
  queryIntent: string | null;
  condensedQuery: string | null;
  source: string | null;
  qualitySignals: any | null;
  createdAt: string;
}

interface Gap {
  category: string;
  severity: 'high' | 'medium' | 'low';
  query: string;
  sessionId: string;
  details: string;
  logId?: number;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let project = '';
  let limit = 200;
  let days = 30;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' && args[i + 1]) project = args[i + 1];
    if (args[i] === '--limit' && args[i + 1]) limit = parseInt(args[i + 1], 10);
    if (args[i] === '--days' && args[i + 1]) days = parseInt(args[i + 1], 10);
    if (args[i] === '--user' && args[i + 1]) process.env.EVAL_STRAPI_USER = args[i + 1];
    if (args[i] === '--pass' && args[i + 1]) process.env.EVAL_STRAPI_PASS = args[i + 1];
    if (args[i] === '--url' && args[i + 1]) process.env.EVAL_STRAPI_URL = args[i + 1];
  }
  if (!project) {
    console.error('Usage: npx tsx scripts/eval-chat-gaps.ts --project <slug> [--limit 200] [--days 30] [--user <user> --pass <pass>]');
    process.exit(1);
  }
  return { project, limit, days };
}

async function fetchChatLogs(project: string, limit: number, days: number): Promise<ChatLog[]> {
  const dateFrom = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
  const headers = await getAuthHeaders();
  const allLogs: ChatLog[] = [];
  let page = 1;
  const pageSize = Math.min(limit, 100);

  while (allLogs.length < limit) {
    const url = `${STRAPI_URL}/chat-logs?projectSlug=${encodeURIComponent(project)}&dateFrom=${dateFrom}&pageSize=${pageSize}&page=${page}`;
    const resp = await fetch(url, { headers });

    if (!resp.ok) {
      throw new Error(`Failed to fetch chat logs: HTTP ${resp.status} ${await resp.text()}`);
    }

    const data = (await resp.json()) as any;
    const logs: ChatLog[] = data.data || [];
    if (logs.length === 0) break;
    allLogs.push(...logs);

    const total = data.meta?.pagination?.total || 0;
    if (allLogs.length >= total || allLogs.length >= limit) break;
    page++;
  }

  return allLogs.slice(0, limit);
}

function analyzeGaps(logs: ChatLog[]): Gap[] {
  const gaps: Gap[] = [];

  for (const log of logs) {
    // 1. Explicit errors
    if (log.error) {
      gaps.push({
        category: 'error',
        severity: 'high',
        query: log.query,
        sessionId: log.sessionId,
        details: log.error.slice(0, 200),
        logId: log.id,
      });
      continue;
    }

    // 2. No reply or very short reply (agent couldn't help)
    const replyLen = log.reply?.length || 0;
    if (replyLen < 30 && log.query.length > 10) {
      gaps.push({
        category: 'weak_reply',
        severity: 'medium',
        query: log.query,
        sessionId: log.sessionId,
        details: `Reply only ${replyLen} chars: "${(log.reply || '').slice(0, 100)}"`,
        logId: log.id,
      });
    }

    // 3. No RAG context for data queries (LOOKUP/SEARCH should have context)
    const intent = log.queryIntent?.toUpperCase();
    const ragHits = Array.isArray(log.ragContext) ? log.ragContext.length : 0;
    if ((intent === 'LOOKUP' || intent === 'SEARCH' || intent === 'SUMMARY') && ragHits === 0) {
      gaps.push({
        category: 'no_rag_context',
        severity: 'medium',
        query: log.query,
        sessionId: log.sessionId,
        details: `Intent=${intent} but 0 RAG hits — agent had no data context`,
        logId: log.id,
      });
    }

    // 4. Tool call errors
    if (Array.isArray(log.toolCalls)) {
      const errors = log.toolCalls.filter((tc: any) => tc.isError);
      if (errors.length > 0) {
        gaps.push({
          category: 'tool_error',
          severity: 'high',
          query: log.query,
          sessionId: log.sessionId,
          details: `${errors.length} tool error(s): ${errors.map((tc: any) => `${tc.name}: ${(tc.result || '').slice(0, 100)}`).join('; ')}`,
          logId: log.id,
        });
      }
    }

    // 5. High latency (>30s)
    if (log.durationMs && log.durationMs > 30000) {
      gaps.push({
        category: 'slow_response',
        severity: 'low',
        query: log.query,
        sessionId: log.sessionId,
        details: `${Math.round(log.durationMs / 1000)}s response time, ${log.iterations || 1} iterations`,
        logId: log.id,
      });
    }

    // 6. Too many iterations (agent looping)
    if (log.iterations && log.iterations >= 4) {
      gaps.push({
        category: 'excessive_iterations',
        severity: 'medium',
        query: log.query,
        sessionId: log.sessionId,
        details: `${log.iterations} iterations — agent may be struggling`,
        logId: log.id,
      });
    }

    // 7. Generic/deflecting replies
    if (log.reply && /i don't have|i cannot|i'm not able|không thể|không có thông tin/i.test(log.reply)) {
      gaps.push({
        category: 'deflection',
        severity: 'medium',
        query: log.query,
        sessionId: log.sessionId,
        details: `Agent deflected: "${log.reply.slice(0, 150)}"`,
        logId: log.id,
      });
    }
  }

  return gaps;
}

function computeStats(logs: ChatLog[]) {
  const total = logs.length;
  const withErrors = logs.filter((l) => l.error).length;
  const withToolCalls = logs.filter((l) => Array.isArray(l.toolCalls) && l.toolCalls.length > 0).length;
  const withRag = logs.filter((l) => Array.isArray(l.ragContext) && l.ragContext.length > 0).length;

  // Intent distribution
  const intentDist: Record<string, number> = {};
  for (const log of logs) {
    const intent = log.queryIntent?.toUpperCase() || 'UNKNOWN';
    intentDist[intent] = (intentDist[intent] || 0) + 1;
  }

  // Tool usage distribution
  const toolDist: Record<string, number> = {};
  for (const log of logs) {
    if (Array.isArray(log.toolCalls)) {
      for (const tc of log.toolCalls) {
        if (tc.name) toolDist[tc.name] = (toolDist[tc.name] || 0) + 1;
      }
    }
  }

  // Source distribution
  const sourceDist: Record<string, number> = {};
  for (const log of logs) {
    const src = log.source || 'unknown';
    sourceDist[src] = (sourceDist[src] || 0) + 1;
  }

  // User distribution
  const userDist: Record<string, number> = {};
  for (const log of logs) {
    const u = log.userKey || 'unknown';
    userDist[u] = (userDist[u] || 0) + 1;
  }

  // Latency stats
  const durations = logs.filter((l) => l.durationMs).map((l) => l.durationMs!);
  const avgDuration = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
  const p95Duration = durations.length > 0 ? durations.sort((a, b) => a - b)[Math.floor(durations.length * 0.95)] : 0;

  // Reply length stats
  const replyLens = logs.filter((l) => l.reply).map((l) => l.reply!.length);
  const avgReply = replyLens.length > 0 ? Math.round(replyLens.reduce((a, b) => a + b, 0) / replyLens.length) : 0;

  // Token usage
  const totalInput = logs.reduce((a, l) => a + (l.usage?.inputTokens || 0), 0);
  const totalOutput = logs.reduce((a, l) => a + (l.usage?.outputTokens || 0), 0);

  return {
    total,
    withErrors,
    withToolCalls,
    withRag,
    intentDist,
    toolDist,
    sourceDist,
    uniqueUsers: Object.keys(userDist).length,
    topUsers: Object.entries(userDist).sort((a, b) => b[1] - a[1]).slice(0, 5),
    avgDuration,
    p95Duration,
    avgReply,
    totalInput,
    totalOutput,
  };
}

function findRepeatedQueries(logs: ChatLog[]): Array<{ query: string; count: number; sessions: string[] }> {
  // Normalize queries and find repetitions
  const queryMap = new Map<string, { count: number; sessions: Set<string>; original: string }>();
  for (const log of logs) {
    const normalized = log.query.toLowerCase().trim().replace(/[?!.,]+$/, '');
    if (normalized.length < 5) continue;
    if (!queryMap.has(normalized)) {
      queryMap.set(normalized, { count: 0, sessions: new Set(), original: log.query });
    }
    const entry = queryMap.get(normalized)!;
    entry.count++;
    entry.sessions.add(log.sessionId);
  }

  return Array.from(queryMap.values())
    .filter((e) => e.sessions.size >= 2) // same question from different sessions
    .sort((a, b) => b.sessions.size - a.sessions.size)
    .slice(0, 15)
    .map((e) => ({ query: e.original, count: e.count, sessions: Array.from(e.sessions) }));
}

async function llmSummarizeGaps(gaps: Gap[], stats: any, project: string): Promise<string | null> {
  if (!LITELLM_URL) return null;

  const gapSummary = Object.entries(
    gaps.reduce((acc, g) => {
      acc[g.category] = (acc[g.category] || 0) + 1;
      return acc;
    }, {} as Record<string, number>)
  ).map(([cat, count]) => `${cat}: ${count}`).join(', ');

  const sampleGaps = gaps
    .filter((g) => g.severity === 'high' || g.severity === 'medium')
    .slice(0, 20)
    .map((g) => `[${g.category}] "${g.query.slice(0, 80)}" — ${g.details.slice(0, 120)}`)
    .join('\n');

  const prompt = `Analyze these chat agent gaps for project "${project}" and provide actionable recommendations.

Stats: ${stats.total} total queries, ${stats.withErrors} errors, ${stats.uniqueUsers} unique users.
Intent distribution: ${JSON.stringify(stats.intentDist)}
Tool distribution: ${JSON.stringify(stats.toolDist)}

Gap counts: ${gapSummary}

Sample gaps (highest severity first):
${sampleGaps}

Provide a concise analysis with:
1. Top 3-5 knowledge gaps the agent is missing
2. Top 3 capability improvements needed
3. Specific data/content that should be added to improve responses
4. Any patterns in user questions that suggest unmet needs

Be specific and actionable. Format as markdown.`;

  try {
    const resp = await fetch(`${LITELLM_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(LITELLM_KEY && { Authorization: `Bearer ${LITELLM_KEY}` }),
      },
      body: JSON.stringify({
        model: process.env.LITELLM_MODEL || 'anthropic/claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1500,
        temperature: 0.3,
      }),
    });

    if (!resp.ok) return null;
    const data = (await resp.json()) as any;
    return data.choices?.[0]?.message?.content || null;
  } catch {
    return null;
  }
}

// ─── Print ───

function printReport(stats: any, gaps: Gap[], repeated: any[], llmAnalysis: string | null, project: string) {
  console.log('\n' + '═'.repeat(70));
  console.log(`  CHAT GAP ANALYSIS: ${project}`);
  console.log('═'.repeat(70));

  console.log(`\n📊 Overview`);
  console.log(`  Total logs:       ${stats.total}`);
  console.log(`  Errors:           ${stats.withErrors}`);
  console.log(`  With tool calls:  ${stats.withToolCalls}`);
  console.log(`  With RAG context: ${stats.withRag}`);
  console.log(`  Unique users:     ${stats.uniqueUsers}`);
  console.log(`  Avg latency:      ${stats.avgDuration}ms (p95: ${stats.p95Duration}ms)`);
  console.log(`  Avg reply length: ${stats.avgReply} chars`);
  console.log(`  Total tokens:     ${stats.totalInput} in / ${stats.totalOutput} out`);

  console.log(`\n📌 Intent Distribution`);
  for (const [intent, count] of Object.entries(stats.intentDist).sort((a: any, b: any) => b[1] - a[1])) {
    const pct = Math.round(((count as number) / stats.total) * 100);
    const bar = '█'.repeat(Math.min(pct, 40));
    console.log(`  ${(intent as string).padEnd(10)} ${String(count).padEnd(4)} ${pct}% ${bar}`);
  }

  if (Object.keys(stats.toolDist).length > 0) {
    console.log(`\n🔧 Tool Usage`);
    for (const [tool, count] of Object.entries(stats.toolDist).sort((a: any, b: any) => b[1] - a[1])) {
      console.log(`  ${(tool as string).padEnd(30)} ${count}`);
    }
  }

  console.log(`\n📡 Source Distribution`);
  for (const [src, count] of Object.entries(stats.sourceDist).sort((a: any, b: any) => b[1] - a[1])) {
    console.log(`  ${(src as string).padEnd(15)} ${count}`);
  }

  // Gap summary by category
  const gapsByCategory = gaps.reduce((acc, g) => {
    if (!acc[g.category]) acc[g.category] = { high: 0, medium: 0, low: 0, total: 0 };
    acc[g.category][g.severity]++;
    acc[g.category].total++;
    return acc;
  }, {} as Record<string, { high: number; medium: number; low: number; total: number }>);

  console.log(`\n⚠️  Gaps Found: ${gaps.length}`);
  console.log('  ' + 'Category'.padEnd(25) + 'Total'.padEnd(7) + 'High'.padEnd(7) + 'Med'.padEnd(7) + 'Low');
  console.log('  ' + '-'.repeat(55));
  for (const [cat, counts] of Object.entries(gapsByCategory).sort((a, b) => b[1].total - a[1].total)) {
    console.log(
      '  ' + cat.padEnd(25) + String(counts.total).padEnd(7) +
      String(counts.high).padEnd(7) + String(counts.medium).padEnd(7) + String(counts.low)
    );
  }

  // High severity gaps
  const highGaps = gaps.filter((g) => g.severity === 'high');
  if (highGaps.length > 0) {
    console.log(`\n🔴 High Severity Gaps (${highGaps.length})`);
    for (const g of highGaps.slice(0, 10)) {
      console.log(`  [${g.category}] "${g.query.slice(0, 60)}"`);
      console.log(`    ${g.details.slice(0, 120)}`);
    }
  }

  // Repeated questions
  if (repeated.length > 0) {
    console.log(`\n🔁 Repeated Questions (${repeated.length} patterns)`);
    for (const r of repeated.slice(0, 10)) {
      console.log(`  ${r.sessions.length} sessions, ${r.count}x: "${r.query.slice(0, 70)}"`);
    }
  }

  // LLM analysis
  if (llmAnalysis) {
    console.log(`\n🤖 AI Analysis`);
    console.log(llmAnalysis);
  }

  console.log('\n' + '═'.repeat(70));
}

// ─── Main ───

async function main() {
  const { project, limit, days } = parseArgs();

  console.log(`Fetching chat logs for "${project}" (last ${days} days, limit ${limit})...`);
  const logs = await fetchChatLogs(project, limit, days);
  console.log(`Fetched ${logs.length} chat logs`);

  if (logs.length === 0) {
    console.log('No chat logs found.');
    return;
  }

  const stats = computeStats(logs);
  const gaps = analyzeGaps(logs);
  const repeated = findRepeatedQueries(logs);

  console.log('Running LLM gap analysis...');
  const llmAnalysis = await llmSummarizeGaps(gaps, stats, project);

  printReport(stats, gaps, repeated, llmAnalysis, project);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
