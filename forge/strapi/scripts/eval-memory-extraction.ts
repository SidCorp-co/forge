/**
 * Eval script: test new memory extraction against real production chat logs.
 *
 * Pulls multi-turn conversations from chat_logs, runs extractMemories extraction
 * prompt against them, and prints extracted facts + edges for manual review.
 *
 * Usage: npx tsx scripts/eval-memory-extraction.ts
 */
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import Database from 'better-sqlite3';

const DB_PATH = path.resolve(__dirname, '..', '.tmp', 'data.db');

// The extraction prompt from memory.ts (duplicated here for standalone eval)
const EXTRACTION_PROMPT = `Extract reusable facts and entity relationships from this conversation.

## Rules
- A fact must pass: "Would knowing this change how I respond in a FUTURE conversation?"
- Preserve the original language. Do not translate. Vietnamese facts stay Vietnamese.
- Max 3 facts, max 3 edges. If nothing qualifies, output {"facts":[],"edges":[]}

## Categories
- preference: user explicitly requested a behavior ("respond in Vietnamese", "sort by priority")
- correction: user corrected the agent's assumption ("no, deploy branch is master not main")
- convention: team/project rule or naming convention ("title format: [$page] mô tả ngắn gọn")

## Good examples (extract these)
- "trang /employee lọc tìm kiếm cần tìm theo họ, tên đệm, tên" → convention, project
- "always use bullet points" → preference, user
- "API endpoint is /v2 not /v1" → correction, project
- "permission filter in backend, not chat filter" → correction, project

## Bad examples (output empty arrays for these)
- "user is exploring project hubs" → narration of what happened, not a rule
- "user wants to duplicate a task" → one-time action, not reusable
- "uses hub MCP tools to look up data" → describing tool usage, obvious
- "ISS-1 is the first issue" → trivial, no behavioral impact
- "user asked about deployment" → topic, not a rule
- "the user requests task counts" → one-time query, not a preference

## Entity relationships (knowledge graph edges)
Extract subject→predicate→object when the conversation reveals project structure.
Predicates: role_in, owns, depends_on, has_rule, has_convention, related_to, part_of, uses

## Output JSON only:
{"facts":[{"fact":"...","scope":"user|project","category":"preference|correction|convention"}],"edges":[{"subject":"...","predicate":"...","object":"...","value":"optional detail"}]}

Conversation:
{last_messages}`;

interface ChatLogRow {
  session_id: string;
  query: string;
  reply: string;
  created_at: number;
}

async function callLLM(prompt: string): Promise<string> {
  const apiUrl = process.env.LITELLM_API_URL;
  const apiKey = process.env.LITELLM_API_KEY;
  if (!apiUrl) throw new Error('LITELLM_API_URL not set');

  const fastModel = process.env.LITELLM_FAST_MODEL || process.env.LITELLM_MODEL || 'gemini-flash';

  const resp = await fetch(`${apiUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
    },
    body: JSON.stringify({
      model: fastModel,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 400,
      temperature: 0,
    }),
  });

  if (!resp.ok) throw new Error(`LLM call failed: ${resp.status} ${await resp.text()}`);
  const data = (await resp.json()) as any;
  return (data.choices?.[0]?.message?.content || '').trim();
}

async function main() {
  const db = new Database(DB_PATH, { readonly: true });

  // Find sessions with 3+ turns
  const sessions = db
    .prepare(
      `SELECT session_id, COUNT(*) as turns
       FROM chat_logs
       WHERE query IS NOT NULL AND LENGTH(query) > 10
       GROUP BY session_id
       HAVING turns >= 3
       ORDER BY MAX(created_at) DESC
       LIMIT 8`,
    )
    .all() as { session_id: string; turns: number }[];

  console.log(`Found ${sessions.length} sessions with 3+ turns\n`);

  let totalFacts = 0;
  let totalEdges = 0;
  let emptyExtractions = 0;

  for (const session of sessions) {
    const rows = db
      .prepare(
        `SELECT session_id, query, reply, created_at
         FROM chat_logs
         WHERE session_id = ? AND query IS NOT NULL
         ORDER BY created_at ASC
         LIMIT 8`,
      )
      .all(session.session_id) as ChatLogRow[];

    // Build messages like the real extractMemories does
    const messages = rows.flatMap((r) => [
      { role: 'user' as const, content: r.query },
      ...(r.reply ? [{ role: 'assistant' as const, content: r.reply }] : []),
    ]);

    const recent = messages.slice(-8);
    const messagesStr = recent
      .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 300) : '[complex]'}`)
      .join('\n');

    const prompt = EXTRACTION_PROMPT.replace('{last_messages}', messagesStr);

    console.log(`\n${'='.repeat(70)}`);
    console.log(`Session: ${session.session_id} (${session.turns} turns)`);
    console.log(`Sample user queries:`);
    for (const r of rows.slice(0, 3)) {
      console.log(`  → ${r.query.slice(0, 80)}`);
    }

    try {
      const raw = await callLLM(prompt);
      const jsonStr = raw.replace(/^```json?\s*/, '').replace(/\s*```$/, '');
      const parsed = JSON.parse(jsonStr) as { facts?: any[]; edges?: any[] };

      const facts = parsed.facts || [];
      const edges = parsed.edges || [];

      if (facts.length === 0 && edges.length === 0) {
        console.log(`\n  Result: ✓ Empty (correctly filtered noise)`);
        emptyExtractions++;
      } else {
        if (facts.length > 0) {
          console.log(`\n  Facts (${facts.length}):`);
          for (const f of facts) {
            console.log(`    [${f.category}/${f.scope}] ${f.fact}`);
          }
          totalFacts += facts.length;
        }
        if (edges.length > 0) {
          console.log(`  Edges (${edges.length}):`);
          for (const e of edges) {
            console.log(`    ${e.subject} —${e.predicate}→ ${e.object}${e.value ? `: ${e.value}` : ''}`);
          }
          totalEdges += edges.length;
        }
      }
    } catch (err) {
      console.log(`  ERROR: ${err}`);
    }
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`SUMMARY`);
  console.log(`  Sessions tested: ${sessions.length}`);
  console.log(`  Empty extractions (noise filtered): ${emptyExtractions}/${sessions.length}`);
  console.log(`  Total facts extracted: ${totalFacts}`);
  console.log(`  Total edges extracted: ${totalEdges}`);
  console.log(`  Avg facts/session: ${(totalFacts / sessions.length).toFixed(1)}`);

  db.close();
}

main().catch(console.error);
