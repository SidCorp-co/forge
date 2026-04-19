/**
 * Evaluation Orchestrator — Full end-to-end replay of prod sessions.
 *
 * Connects to prod Postgres (read-only), fetches multi-turn sessions,
 * replays each user turn through the LOCAL Strapi chat endpoint (POST /api/chat),
 * compares old vs new: intent, condensed query, RAG context, tool calls, reply.
 * Stores results in local Strapi eval-run content type.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... npx tsx scripts/eval-orchestrator.ts [--limit 5] [--project hrm] [--mode rag|full|regression]
 *
 * Modes:
 *   rag        — RAG Gate only (fast, ~$0.01/session, no side effects)
 *   full       — Full chat pipeline via /api/chat (slower, ~$0.10/session, creates sessions + logs)
 *   regression — Fetch flagged/bad logs from local Strapi and replay them through the full pipeline
 */
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import pg from 'pg';
import { ragGate } from '../src/services/rag-gate/index';

const DATABASE_URL = process.env.DATABASE_URL;
const STRAPI_URL = process.env.EVAL_STRAPI_URL || 'http://localhost:1337/api';
const API_KEY = process.env.EVAL_API_KEY;
if (!API_KEY) throw new Error('EVAL_API_KEY env var required');

const mockStrapi: any = {
  log: {
    info: () => {},
    warn: () => {},
    error: (...args: any[]) => console.error('  [err]', ...args),
  },
};

function parseArgs() {
  const args = process.argv.slice(2);
  let limit = 0;
  let project = '';
  let mode: 'rag' | 'full' | 'regression' = 'full';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) limit = parseInt(args[i + 1], 10);
    if (args[i] === '--project' && args[i + 1]) project = args[i + 1];
    if (args[i] === '--mode' && args[i + 1]) mode = args[i + 1] as 'rag' | 'full' | 'regression';
  }
  return { limit, project, mode };
}

// ─── Types ───

interface OldTurn {
  sessionId: string;
  projectSlug: string;
  query: string;
  oldReply: string | null;
  oldIntent: string | null;
  oldCondensed: string | null;
  oldRagContext: any[] | null;
  oldToolCalls: any[] | null;
  oldUsage: any | null;
  oldIterations: number | null;
  oldDurationMs: number | null;
  createdAt: string;
}

interface SessionGroup {
  sessionId: string;
  projectSlug: string;
  messages: Array<{ role: string; content: string }>;
  turns: OldTurn[];
}

interface TurnResult {
  turnIndex: number;
  sessionId: string;
  projectSlug: string;
  query: string;
  // Old pipeline
  oldIntent: string | null;
  oldCondensed: string | null;
  oldRagHits: number;
  oldToolNames: string[];
  oldReplyLen: number;
  oldDurationMs: number | null;
  oldIterations: number | null;
  // New pipeline
  newIntent: string | null;
  newCondensed: string | null;
  newRagHits: number | null;
  newToolNames: string[];
  newReplyLen: number;
  newReply: string | null;
  newDurationMs: number | null;
  newIterations: number | null;
  newUsage: any | null;
  // Comparison
  intentMatch: boolean;
  intentChanged: string | null;
  toolSetMatch: boolean;
  replyLenDelta: number;
  ragHitDelta: number;
  // Quality scores (LLM-judged, 1-5)
  qualityScore?: number | null;       // new reply quality
  qualityVerdict?: string | null;     // "better" | "worse" | "same" | "different"
  qualityReason?: string | null;
  oldReply?: string | null;        // kept for scoring, trimmed in final output
}

// ─── Fetch flagged logs from local Strapi (regression mode) ───

async function fetchFlaggedSessions(opts: { limit: number; project: string }): Promise<SessionGroup[]> {
  const params = new URLSearchParams();
  params.set('limit', String(opts.limit > 0 ? opts.limit * 5 : 100));
  if (opts.project) params.set('projectSlug', opts.project);

  const resp = await fetch(`${STRAPI_URL}/chat-logs/flagged?${params.toString()}`, {
    headers: { 'X-Forge-API-Key': API_KEY },
  });

  if (!resp.ok) {
    throw new Error(`Failed to fetch flagged logs: HTTP ${resp.status} ${await resp.text()}`);
  }

  const flaggedLogs = (await resp.json()) as any[];

  // Group by sessionId
  const groups = new Map<string, SessionGroup>();
  for (const log of flaggedLogs) {
    const sid = log.sessionId || log.id;
    if (!groups.has(sid)) {
      groups.set(sid, {
        sessionId: sid,
        projectSlug: log.projectSlug,
        messages: [],
        turns: [],
      });
    }
    groups.get(sid)!.turns.push({
      sessionId: sid,
      projectSlug: log.projectSlug,
      query: log.input.query,
      oldReply: log.actual.reply,
      oldIntent: log.input.queryIntent,
      oldCondensed: log.input.condensedQuery,
      oldRagContext: log.actual.ragContext,
      oldToolCalls: log.actual.toolCalls,
      oldUsage: log.actual.usage,
      oldIterations: log.actual.iterations,
      oldDurationMs: log.actual.durationMs,
      createdAt: log.createdAt,
    });
  }

  let sessions = Array.from(groups.values());
  if (opts.limit > 0) sessions = sessions.slice(0, opts.limit);
  return sessions;
}

// ─── Fetch from prod DB ───

async function fetchSessions(pool: pg.Pool, opts: { limit: number; project: string }): Promise<SessionGroup[]> {
  let whereClause = '';
  const params: string[] = [];

  if (opts.project) {
    params.push(opts.project);
    whereClause += ` AND cl.project_slug = $${params.length}`;
  }

  const query = `
    SELECT
      cl.session_id,
      cl.project_slug,
      cl.query,
      cl.reply,
      cl.query_intent,
      cl.condensed_query,
      cl.rag_context,
      cl.tool_calls,
      cl.usage,
      cl.iterations,
      cl.duration_ms,
      cl.created_at,
      cs.messages as session_messages
    FROM chat_logs cl
    LEFT JOIN chat_sessions cs ON cs.document_id = cl.session_id
    WHERE cl.session_id IS NOT NULL
      AND cl.query IS NOT NULL
      ${whereClause}
    ORDER BY cl.session_id, cl.created_at ASC
  `;

  const result = await pool.query(query, params);

  const groups = new Map<string, SessionGroup>();
  for (const row of result.rows) {
    const sid = row.session_id;
    if (!groups.has(sid)) {
      groups.set(sid, {
        sessionId: sid,
        projectSlug: row.project_slug,
        messages: Array.isArray(row.session_messages) ? row.session_messages : [],
        turns: [],
      });
    }
    groups.get(sid)!.turns.push({
      sessionId: sid,
      projectSlug: row.project_slug,
      query: row.query,
      oldReply: row.reply,
      oldIntent: row.query_intent,
      oldCondensed: row.condensed_query,
      oldRagContext: row.rag_context,
      oldToolCalls: row.tool_calls,
      oldUsage: row.usage,
      oldIterations: row.iterations,
      oldDurationMs: row.duration_ms,
      createdAt: row.created_at,
    });
  }

  // Filter to sessions with >=3 user turns
  let sessions = Array.from(groups.values()).filter((s) => s.turns.length >= 3);
  if (opts.limit > 0) sessions = sessions.slice(0, opts.limit);
  return sessions;
}

// ─── RAG-only replay ───

async function replaySessionRagOnly(session: SessionGroup): Promise<TurnResult[]> {
  const results: TurnResult[] = [];

  for (let i = 0; i < session.turns.length; i++) {
    const turn = session.turns[i];

    const historyTurns: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    if (session.messages.length > 0) {
      for (const msg of session.messages) {
        if (msg.role === 'user' && msg.content === turn.query) break;
        if (msg.role === 'user' || msg.role === 'assistant') {
          historyTurns.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
        }
      }
    } else {
      for (let j = 0; j < i; j++) {
        historyTurns.push({ role: 'user', content: session.turns[j].query });
      }
    }

    const gate = await ragGate(mockStrapi, turn.query, historyTurns);
    const oldRagHits = Array.isArray(turn.oldRagContext) ? turn.oldRagContext.length : 0;
    const oldToolNames = Array.isArray(turn.oldToolCalls)
      ? turn.oldToolCalls.map((tc: any) => tc.name).filter(Boolean)
      : [];

    const intentMatch = !turn.oldIntent || turn.oldIntent.toUpperCase() === gate.intent;
    const intentChanged = !intentMatch && turn.oldIntent
      ? `${turn.oldIntent.toUpperCase()}\u2192${gate.intent}`
      : null;

    results.push({
      turnIndex: i,
      sessionId: turn.sessionId,
      projectSlug: turn.projectSlug,
      query: turn.query,
      oldIntent: turn.oldIntent,
      oldCondensed: turn.oldCondensed,
      oldRagHits,
      oldToolNames,
      oldReplyLen: turn.oldReply?.length || 0,
      oldDurationMs: turn.oldDurationMs,
      oldIterations: turn.oldIterations,
      newIntent: gate.intent,
      newCondensed: gate.wasCondensed ? gate.standaloneQuery : null,
      newRagHits: null,
      newToolNames: [],
      newReplyLen: 0,
      newReply: null,
      newDurationMs: null,
      newIterations: null,
      newUsage: null,
      intentMatch,
      intentChanged,
      toolSetMatch: true,
      replyLenDelta: 0,
      ragHitDelta: 0,
    });
  }

  return results;
}

// ─── Full chat replay ───

async function replaySessionFull(session: SessionGroup): Promise<TurnResult[]> {
  const results: TurnResult[] = [];
  let evalSessionId: string | undefined;

  for (let i = 0; i < session.turns.length; i++) {
    const turn = session.turns[i];
    const startMs = Date.now();

    try {
      const body: Record<string, unknown> = {
        message: turn.query,
        projectSlug: turn.projectSlug,
      };
      if (evalSessionId) body.sessionId = evalSessionId;

      const resp = await fetch(`${STRAPI_URL}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forge-API-Key': API_KEY,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });

      const durationMs = Date.now() - startMs;

      if (!resp.ok) {
        const errText = await resp.text();
        console.error(`    Turn ${i} failed: HTTP ${resp.status} ${errText.slice(0, 200)}`);
        results.push(makeErrorResult(i, turn, durationMs, `HTTP ${resp.status}`));
        continue;
      }

      const data = (await resp.json()) as any;
      const chatResult = data.data;
      if (!evalSessionId) evalSessionId = chatResult.sessionId;

      // Now fetch the chat log that was just created to get intent/ragContext
      const newLog = await fetchLatestChatLog(evalSessionId!, turn.query);

      const oldRagHits = Array.isArray(turn.oldRagContext) ? turn.oldRagContext.length : 0;
      const newRagHits = newLog?.ragHits ?? 0;
      const oldToolNames = extractToolNames(turn.oldToolCalls);
      const newToolNames = (chatResult.toolCalls || []).map((tc: any) => tc.name);
      const newReplyLen = chatResult.reply?.length || 0;

      const oldIntent = turn.oldIntent?.toUpperCase() || null;
      const newIntent = newLog?.queryIntent?.toUpperCase() || null;
      const intentMatch = !oldIntent || !newIntent || oldIntent === newIntent;
      const intentChanged = !intentMatch ? `${oldIntent}\u2192${newIntent}` : null;

      const toolSetMatch = arraysEqual(oldToolNames.sort(), newToolNames.sort());

      results.push({
        turnIndex: i,
        sessionId: turn.sessionId,
        projectSlug: turn.projectSlug,
        query: turn.query,
        oldIntent,
        oldCondensed: turn.oldCondensed,
        oldRagHits,
        oldToolNames,
        oldReplyLen: turn.oldReply?.length || 0,
        oldDurationMs: turn.oldDurationMs,
        oldIterations: turn.oldIterations,
        newIntent,
        newCondensed: newLog?.condensedQuery || null,
        newRagHits,
        newToolNames,
        newReplyLen,
        newReply: chatResult.reply?.slice(0, 500) || null,
        newDurationMs: durationMs,
        newIterations: chatResult.iterations || null,
        newUsage: chatResult.usage || null,
        intentMatch,
        intentChanged,
        toolSetMatch,
        replyLenDelta: newReplyLen - (turn.oldReply?.length || 0),
        ragHitDelta: newRagHits - oldRagHits,
        oldReply: turn.oldReply?.slice(0, 500) || null,
      });

      console.log(
        `    Turn ${i}: ${(newIntent || '?').padEnd(8)} ${durationMs}ms ` +
        `tools=[${newToolNames.join(',')}] ` +
        `reply=${newReplyLen}ch ` +
        `"${turn.query.slice(0, 50)}"`,
      );
    } catch (err: any) {
      const durationMs = Date.now() - startMs;
      console.error(`    Turn ${i} error: ${err.message}`);
      results.push(makeErrorResult(i, turn, durationMs, err.message));
    }
  }

  return results;
}

function makeErrorResult(turnIndex: number, turn: OldTurn, durationMs: number, error: string): TurnResult {
  const oldRagHits = Array.isArray(turn.oldRagContext) ? turn.oldRagContext.length : 0;
  return {
    turnIndex,
    sessionId: turn.sessionId,
    projectSlug: turn.projectSlug,
    query: turn.query,
    oldIntent: turn.oldIntent,
    oldCondensed: turn.oldCondensed,
    oldRagHits,
    oldToolNames: extractToolNames(turn.oldToolCalls),
    oldReplyLen: turn.oldReply?.length || 0,
    oldDurationMs: turn.oldDurationMs,
    oldIterations: turn.oldIterations,
    newIntent: 'ERROR',
    newCondensed: null,
    newRagHits: 0,
    newToolNames: [],
    newReplyLen: 0,
    newReply: error,
    newDurationMs: durationMs,
    newIterations: null,
    newUsage: null,
    intentMatch: false,
    intentChanged: `${turn.oldIntent || '?'}\u2192ERROR`,
    toolSetMatch: false,
    replyLenDelta: -(turn.oldReply?.length || 0),
    ragHitDelta: -oldRagHits,
    oldReply: turn.oldReply?.slice(0, 500) || null,
  };
}

async function fetchLatestChatLog(sessionId: string, query: string): Promise<{
  queryIntent: string | null;
  condensedQuery: string | null;
  ragHits: number;
} | null> {
  // Chat log is created async — give it a moment
  await new Promise((r) => setTimeout(r, 500));
  try {
    const resp = await fetch(
      `${STRAPI_URL}/chat-logs/recent?sessionId=${encodeURIComponent(sessionId)}&limit=5`,
      { headers: { 'X-Forge-API-Key': API_KEY } },
    );
    if (!resp.ok) return null;
    const logs = (await resp.json()) as any[];
    const log = logs.find((l: any) => l.query === query) || logs[0];
    if (!log) return null;
    const attrs = log;
    return {
      queryIntent: attrs.queryIntent || null,
      condensedQuery: attrs.condensedQuery || null,
      ragHits: Array.isArray(attrs.ragContext) ? attrs.ragContext.length : 0,
    };
  } catch {
    return null;
  }
}

function extractToolNames(toolCalls: any): string[] {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((tc: any) => tc.name).filter(Boolean);
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ─── Reply quality scoring (LLM-as-judge) ───

const QUALITY_PROMPT = `You are an evaluator comparing two chatbot replies to the same user query.

User query: "{query}"

Old reply:
{oldReply}

New reply:
{newReply}

Rate the NEW reply compared to the OLD reply. Output ONLY valid JSON:
{"score": <1-5>, "verdict": "<better|worse|same|different>", "reason": "<1 sentence>"}

Scoring guide:
- 5: New is clearly better (more helpful, correct, actionable)
- 4: New is slightly better
- 3: Both are equivalent
- 2: New is slightly worse
- 1: New is clearly worse (wrong, unhelpful, missing key info)
Use "different" verdict when replies address different aspects and can't be directly compared.`;

async function scoreReplies(results: TurnResult[]): Promise<void> {
  const apiUrl = process.env.LITELLM_API_URL;
  const apiKey = process.env.LITELLM_API_KEY;
  if (!apiUrl) {
    console.log('  Skipping quality scoring (no LITELLM_API_URL)');
    return;
  }

  // Only score turns where both old and new replies exist and are non-trivial
  const scoreable = results.filter(
    (r) => r.newReply && r.newReply.length > 20 && r.oldReplyLen > 20 && r.newIntent !== 'ERROR',
  );

  if (scoreable.length === 0) return;
  console.log(`  Scoring ${scoreable.length} replies...`);

  // Score in batches of 5 to avoid rate limits
  for (let i = 0; i < scoreable.length; i += 5) {
    const batch = scoreable.slice(i, i + 5);
    await Promise.all(batch.map(async (r) => {
      try {
        const prompt = QUALITY_PROMPT
          .replace('{query}', r.query.slice(0, 200))
          .replace('{oldReply}', r.oldReply || '(not available)')
          .replace('{newReply}', (r.newReply || '').slice(0, 500));

        const resp = await fetch(`${apiUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
          },
          body: JSON.stringify({
            model: process.env.LITELLM_FAST_MODEL || 'gemini-flash',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 100,
            temperature: 0,
          }),
        });

        if (!resp.ok) return;
        const data = (await resp.json()) as any;
        const raw = (data.choices?.[0]?.message?.content || '').trim();
        const json = JSON.parse(raw.replace(/^```json?\s*/, '').replace(/\s*```$/, ''));

        r.qualityScore = json.score;
        r.qualityVerdict = json.verdict;
        r.qualityReason = json.reason;
      } catch {
        // silently skip scoring errors
      }
    }));
  }
}

// ─── Summary & output ───

function computeSummary(allResults: TurnResult[], mode: string) {
  const sessionIds = new Set(allResults.map((r) => r.sessionId));
  const total = allResults.length;
  const errors = allResults.filter((r) => r.newIntent === 'ERROR').length;
  const valid = allResults.filter((r) => r.newIntent !== 'ERROR');

  // Intent
  const intentMatches = valid.filter((r) => r.intentMatch).length;
  const intentChanges: Record<string, number> = {};
  for (const r of valid) {
    if (r.intentChanged) {
      intentChanges[r.intentChanged] = (intentChanges[r.intentChanged] || 0) + 1;
    }
  }

  // New intent distribution
  const newIntentDist: Record<string, number> = {};
  for (const r of valid) {
    const intent = r.newIntent || 'UNKNOWN';
    newIntentDist[intent] = (newIntentDist[intent] || 0) + 1;
  }

  // RAG
  const ragSkips = valid.filter((r) => r.newIntent === 'CHAT' || r.newIntent === 'ACTION').length;
  const condensed = valid.filter((r) => r.newCondensed).length;

  const base: Record<string, unknown> = {
    mode,
    totalSessions: sessionIds.size,
    totalTurns: total,
    errors,
    intentMatchRate: valid.length > 0 ? Math.round((intentMatches / valid.length) * 100) : 0,
    intentChanges,
    newIntentDistribution: newIntentDist,
    condensationRate: valid.length > 0 ? Math.round((condensed / valid.length) * 100) : 0,
    ragSkipRate: valid.length > 0 ? Math.round((ragSkips / valid.length) * 100) : 0,
  };

  // Full-mode-only metrics
  if (mode === 'full') {
    const withTools = valid.filter((r) => r.newToolNames.length > 0);
    const toolMatches = valid.filter((r) => r.toolSetMatch).length;

    // Tool usage distribution
    const toolDist: Record<string, number> = {};
    for (const r of valid) {
      for (const t of r.newToolNames) {
        toolDist[t] = (toolDist[t] || 0) + 1;
      }
    }

    // Latency comparison
    const oldDurations = valid.filter((r) => r.oldDurationMs).map((r) => r.oldDurationMs!);
    const newDurations = valid.filter((r) => r.newDurationMs).map((r) => r.newDurationMs!);
    const avgOld = oldDurations.length > 0 ? Math.round(oldDurations.reduce((a, b) => a + b, 0) / oldDurations.length) : 0;
    const avgNew = newDurations.length > 0 ? Math.round(newDurations.reduce((a, b) => a + b, 0) / newDurations.length) : 0;

    // Reply length comparison
    const avgOldReply = valid.length > 0 ? Math.round(valid.reduce((a, r) => a + r.oldReplyLen, 0) / valid.length) : 0;
    const avgNewReply = valid.length > 0 ? Math.round(valid.reduce((a, r) => a + r.newReplyLen, 0) / valid.length) : 0;

    // RAG hit comparison
    const avgOldRag = valid.length > 0 ? Math.round(valid.reduce((a, r) => a + r.oldRagHits, 0) / valid.length * 10) / 10 : 0;
    const avgNewRag = valid.filter((r) => r.newRagHits !== null).length > 0
      ? Math.round(valid.filter((r) => r.newRagHits !== null).reduce((a, r) => a + (r.newRagHits || 0), 0) / valid.filter((r) => r.newRagHits !== null).length * 10) / 10
      : 0;

    // Usage/cost
    const totalInput = valid.reduce((a, r) => a + (r.newUsage?.inputTokens || 0), 0);
    const totalOutput = valid.reduce((a, r) => a + (r.newUsage?.outputTokens || 0), 0);

    Object.assign(base, {
      toolMatchRate: valid.length > 0 ? Math.round((toolMatches / valid.length) * 100) : 0,
      turnsWithTools: withTools.length,
      toolDistribution: toolDist,
      avgLatencyOldMs: avgOld,
      avgLatencyNewMs: avgNew,
      avgReplyLenOld: avgOldReply,
      avgReplyLenNew: avgNewReply,
      avgRagHitsOld: avgOldRag,
      avgRagHitsNew: avgNewRag,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
    });

    // Quality scoring metrics
    const scored = valid.filter((r) => r.qualityScore != null);
    if (scored.length > 0) {
      const avgScore = Math.round(scored.reduce((a, r) => a + r.qualityScore!, 0) / scored.length * 10) / 10;
      const verdictDist: Record<string, number> = {};
      for (const r of scored) {
        const v = r.qualityVerdict || 'unknown';
        verdictDist[v] = (verdictDist[v] || 0) + 1;
      }
      Object.assign(base, {
        qualityScoredTurns: scored.length,
        avgQualityScore: avgScore,
        qualityVerdicts: verdictDist,
      });
    }
  }

  return base;
}

function printSessionTable(results: TurnResult[], mode: string) {
  if (mode === 'rag') {
    console.log('\n' + '='.repeat(120));
    console.log(
      'Turn'.padEnd(5) + 'OldIntent'.padEnd(11) + 'NewIntent'.padEnd(11) +
      'Match'.padEnd(6) + 'Cond'.padEnd(6) + 'Query'.padEnd(81),
    );
    console.log('-'.repeat(120));
    for (const r of results) {
      console.log(
        String(r.turnIndex).padEnd(5) +
        (r.oldIntent || '-').padEnd(11) +
        (r.newIntent || '-').padEnd(11) +
        (r.intentMatch ? 'Y' : 'N').padEnd(6) +
        (r.newCondensed ? 'Y' : 'N').padEnd(6) +
        r.query.slice(0, 79),
      );
    }
    console.log('='.repeat(120));
  } else {
    console.log('\n' + '='.repeat(140));
    console.log(
      '#'.padEnd(4) +
      'Intent'.padEnd(16) +
      'Tools(old/new)'.padEnd(30) +
      'Reply'.padEnd(14) +
      'RAG'.padEnd(8) +
      'Ms'.padEnd(10) +
      'Query'.padEnd(58),
    );
    console.log('-'.repeat(140));
    for (const r of results) {
      const intentCol = `${(r.oldIntent || '-').slice(0, 6)}\u2192${(r.newIntent || '-').slice(0, 6)}${r.intentMatch ? '' : '*'}`;
      const oldTools = r.oldToolNames.length > 0 ? r.oldToolNames.map(shortTool).join(',') : '-';
      const newTools = r.newToolNames.length > 0 ? r.newToolNames.map(shortTool).join(',') : '-';
      const toolsCol = `${oldTools}/${newTools}`;
      const replyCol = `${r.oldReplyLen}\u2192${r.newReplyLen}`;
      const ragCol = `${r.oldRagHits}\u2192${r.newRagHits ?? '?'}`;
      const msCol = `${r.oldDurationMs || '?'}\u2192${r.newDurationMs || '?'}`;

      console.log(
        String(r.turnIndex).padEnd(4) +
        intentCol.padEnd(16) +
        toolsCol.slice(0, 28).padEnd(30) +
        replyCol.padEnd(14) +
        ragCol.padEnd(8) +
        msCol.padEnd(10) +
        r.query.slice(0, 56),
      );
    }
    console.log('='.repeat(140));
  }
}

function shortTool(name: string): string {
  return name.replace(/^forge_/, 'f_').replace(/^mcp_/, 'm_');
}

function printSummary(summary: Record<string, unknown>) {
  console.log('\n' + '='.repeat(60));
  console.log('  EVALUATION SUMMARY');
  console.log('='.repeat(60));
  console.log(`Mode:              ${summary.mode}`);
  console.log(`Sessions:          ${summary.totalSessions}`);
  console.log(`Turns:             ${summary.totalTurns}`);
  console.log(`Errors:            ${summary.errors}`);
  console.log(`Intent match:      ${summary.intentMatchRate}%`);
  console.log(`Condensation:      ${summary.condensationRate}%`);
  console.log(`RAG skip rate:     ${summary.ragSkipRate}%`);

  if (summary.mode === 'full') {
    console.log(`Tool set match:    ${summary.toolMatchRate}%`);
    console.log(`Turns with tools:  ${summary.turnsWithTools}`);
    console.log(`Avg latency:       ${summary.avgLatencyOldMs}ms \u2192 ${summary.avgLatencyNewMs}ms`);
    console.log(`Avg reply length:  ${summary.avgReplyLenOld} \u2192 ${summary.avgReplyLenNew} chars`);
    console.log(`Avg RAG hits:      ${summary.avgRagHitsOld} \u2192 ${summary.avgRagHitsNew}`);
    console.log(`Total tokens:      ${summary.totalInputTokens} in / ${summary.totalOutputTokens} out`);
  }

  const intentChanges = summary.intentChanges as Record<string, number>;
  if (Object.keys(intentChanges).length > 0) {
    console.log('\nIntent changes:');
    for (const [change, count] of Object.entries(intentChanges).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${change}: ${count}`);
    }
  }

  const dist = summary.newIntentDistribution as Record<string, number>;
  if (dist) {
    console.log('\nNew intent distribution:');
    for (const [intent, count] of Object.entries(dist).sort((a, b) => b[1] - a[1])) {
      const bar = '\u2588'.repeat(Math.min(count, 40));
      console.log(`  ${intent.padEnd(8)} ${String(count).padEnd(4)} ${bar}`);
    }
  }

  if (summary.mode === 'full') {
    const toolDist = summary.toolDistribution as Record<string, number>;
    if (toolDist && Object.keys(toolDist).length > 0) {
      console.log('\nTool usage distribution:');
      for (const [tool, count] of Object.entries(toolDist).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${tool.padEnd(30)} ${count}`);
      }
    }

    // Quality scores
    if (summary.avgQualityScore) {
      console.log(`\nReply quality (LLM-judged):`)
      console.log(`  Scored turns:    ${summary.qualityScoredTurns}`);
      console.log(`  Avg score:       ${summary.avgQualityScore}/5`);
      const verdicts = summary.qualityVerdicts as Record<string, number>;
      if (verdicts) {
        for (const [v, c] of Object.entries(verdicts).sort((a, b) => b[1] - a[1])) {
          console.log(`  ${v.padEnd(15)} ${c}`);
        }
      }
    }
  }

  console.log('='.repeat(60));
}

// ─── Store results ───

async function postToStrapi(runId: string, allResults: TurnResult[], summary: Record<string, unknown>) {
  try {
    const resp = await fetch(`${STRAPI_URL}/eval-runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forge-API-Key': API_KEY,
      },
      body: JSON.stringify({
        data: {
          runId,
          runAt: new Date().toISOString(),
          totalTurns: allResults.length,
          results: allResults,
          summary,
          status: 'completed',
        },
      }),
    });

    if (!resp.ok) {
      console.warn(`Failed to store eval run: HTTP ${resp.status} ${await resp.text()}`);
    } else {
      console.log(`\nEval run stored: ${runId}`);
    }
  } catch (err: any) {
    console.warn(`Failed to store eval run: ${err.message}`);
  }
}

// ─── Main ───

async function main() {
  const opts = parseArgs();
  const runId = `eval-${opts.mode}-${Date.now()}`;

  // Regression mode: fetch flagged logs from local Strapi, no DB needed
  if (opts.mode === 'regression') {
    console.log(`Mode: regression | Fetching flagged/bad logs from ${STRAPI_URL}...`);

    const sessions = await fetchFlaggedSessions(opts);
    console.log(`Found ${sessions.length} flagged sessions (${sessions.reduce((a, s) => a + s.turns.length, 0)} total turns)`);

    if (sessions.length === 0) {
      console.log('No flagged sessions to evaluate.');
      return;
    }

    const allResults: TurnResult[] = [];
    for (let i = 0; i < sessions.length; i++) {
      const session = sessions[i];
      console.log(`\n[${i + 1}/${sessions.length}] Session ${session.sessionId} (${session.turns.length} turns, project=${session.projectSlug})`);
      const results = await replaySessionFull(session);
      allResults.push(...results);
      printSessionTable(results, 'full');
    }

    console.log('\nScoring reply quality...');
    await scoreReplies(allResults);

    const summary = computeSummary(allResults, 'regression');
    printSummary(summary);

    const storedResults = allResults.map(({ oldReply, ...rest }) => rest);
    await postToStrapi(runId, storedResults as TurnResult[], summary);
    return;
  }

  if (!DATABASE_URL) {
    console.error('DATABASE_URL is required. Usage:');
    console.error('  DATABASE_URL=postgresql://... npx tsx scripts/eval-orchestrator.ts [--limit 10] [--mode rag|full]');
    process.exit(1);
  }

  console.log(`Mode: ${opts.mode} | Connecting to prod DB...`);
  const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

  try {
    const sessions = await fetchSessions(pool, opts);
    console.log(`Found ${sessions.length} sessions with \u22653 turns (${sessions.reduce((a, s) => a + s.turns.length, 0)} total turns)`);

    if (sessions.length === 0) {
      console.log('No sessions to evaluate.');
      return;
    }

    const allResults: TurnResult[] = [];

    for (let i = 0; i < sessions.length; i++) {
      const session = sessions[i];
      console.log(`\n[${ i + 1}/${sessions.length}] Session ${session.sessionId} (${session.turns.length} turns, project=${session.projectSlug})`);

      const results = opts.mode === 'rag'
        ? await replaySessionRagOnly(session)
        : await replaySessionFull(session);

      allResults.push(...results);
      printSessionTable(results, opts.mode);
    }

    // Score reply quality (full mode only)
    if (opts.mode === 'full') {
      console.log('\nScoring reply quality...');
      await scoreReplies(allResults);
    }

    const summary = computeSummary(allResults, opts.mode);
    printSummary(summary);

    // Strip oldReply from stored results to save space
    const storedResults = allResults.map(({ oldReply, ...rest }) => rest);
    await postToStrapi(runId, storedResults as TurnResult[], summary);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
