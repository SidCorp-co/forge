/**
 * Memory extraction from conversations and tool calls.
 */

import type { AIProvider, Message } from '../provider';
import type { ToolCallRecord } from '../runner';
import { extractEntitiesAndEdges } from '../../knowledge-graph/entity-extractor';
import { addMemory } from './crud';
import { listMemories } from './search';

const EXTRACTION_PROMPT = `Extract reusable facts and entity relationships from this conversation.

## Rules
- A fact must pass: "Would knowing this change how I respond in a FUTURE conversation?"
- Preserve the original language. Do not translate. Vietnamese facts stay Vietnamese.
- Max 3 facts, max 3 edges. If nothing qualifies, output {"facts":[],"edges":[]}

## Categories
- preference: user explicitly requested a behavior ("respond in Vietnamese", "sort by priority")
- correction: user corrected the agent's assumption ("no, deploy branch is master not main")
- convention: team/project rule or naming convention ("title format: [$page] mô tả ngắn gọn")
- tool_pattern: a working query/API call pattern the agent discovered ("candidates(filters: {date_from}) returns paginated results")

## Good examples (extract these)
- "trang /employee lọc tìm kiếm cần tìm theo họ, tên đệm, tên" → convention, project
- "always use bullet points" → preference, user
- "API endpoint is /v2 not /v1" → correction, project
- "permission filter in backend, not chat filter" → correction, project
- "candidates(filters: {date_from: 'YYYY-MM-DD'}) returns { data: [...], paginatorInfo: { total } }" → tool_pattern, project

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

{existing_memories}
Conversation:
{last_messages}`;

/**
 * Quick heuristic: skip extraction for short/trivial user messages.
 */
function hasMemoryWorthyContent(messages: Message[]): boolean {
  const userMsgs = messages
    .filter((m) => m.role === 'user')
    .map((m) => (typeof m.content === 'string' ? m.content : '').trim())
    .filter(Boolean);

  const correctionPatterns = /sai rồi|sai|wrong|không phải|no,\s|chỉnh|correct|actually|thực ra/i;
  if (userMsgs.some((msg) => correctionPatterns.test(msg))) return true;

  if (userMsgs.length < 2) return false;

  const trivialPatterns = /^(hi|hello|hey|thanks|thank you|ok|yes|no|list|show|get|create|update|delete|find|search|how many|what is|what are)\b/i;
  return userMsgs.some((msg) => msg.length > 30 && !trivialPatterns.test(msg));
}

/**
 * Extract memories + knowledge edges from conversation using LLM.
 * Runs async, fire-and-forget. Uses fast model.
 */
export async function extractMemories(
  _provider: AIProvider,
  _model: string,
  messages: Message[],
  strapi: any,
  projectDocId: string,
  userKey: string,
  _qualitySignals?: Record<string, any>,
  widgetUserId?: string,
): Promise<void> {
  try {
    if (!hasMemoryWorthyContent(messages)) return;

    const apiUrl = process.env.LITELLM_API_URL;
    const apiKey = process.env.LITELLM_API_KEY;
    if (!apiUrl) return;

    const existing = await listMemories(projectDocId, userKey);
    const existingStr = existing.length > 0
      ? `Existing memories (don't duplicate):\n${existing.map((m) => `- [${m.category}] ${m.content}`).join('\n')}\n\n`
      : '';

    const recent = messages.slice(-8);
    const messagesStr = recent
      .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 300) : '[complex]'}`)
      .join('\n');

    let prompt = EXTRACTION_PROMPT
      .replace('{existing_memories}', existingStr)
      .replace('{last_messages}', messagesStr);

    if (_qualitySignals?.hadToolErrors || (_qualitySignals?.iterations ?? 0) > 3) {
      prompt += '\n\nNote: This conversation had tool errors or many iterations. Pay special attention to user corrections and working patterns that resolved issues.';
    }

    const fastModel = process.env.LITELLM_FAST_MODEL || process.env.LITELLM_MODEL || 'gemini-flash';

    const response = await fetch(`${apiUrl}/chat/completions`, {
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

    if (!response.ok) {
      strapi.log.warn(`[memory] extraction LLM call failed: ${response.status}`);
      return;
    }

    const data = (await response.json()) as any;
    const raw = (data.choices?.[0]?.message?.content || '').trim();
    if (!raw) return;

    let parsed: { facts?: any[]; edges?: any[] };
    try {
      const jsonStr = raw.replace(/^```json?\s*/, '').replace(/\s*```$/, '');
      parsed = JSON.parse(jsonStr);
    } catch {
      strapi.log.debug(`[memory] extraction parse failed: ${raw.slice(0, 100)}`);
      return;
    }

    const validCategories = ['preference', 'correction', 'convention', 'tool_pattern'];

    const facts = Array.isArray(parsed.facts) ? parsed.facts.slice(0, 3) : [];
    for (const f of facts) {
      if (!f.fact || typeof f.fact !== 'string' || f.fact.length < 5) continue;
      const cat = validCategories.includes(f.category) ? f.category : 'convention';
      const scope = f.scope === 'project' ? 'project' : 'user';

      const { sourceId, isUpdate } = await addMemory(projectDocId, userKey, cat, f.fact, scope, 'auto', widgetUserId);
      strapi.log.info(`[memory] ${isUpdate ? 'updated' : 'added'} ${cat}/${scope}: "${f.fact.slice(0, 60)}" (${sourceId})`);

      extractEntitiesAndEdges(strapi, projectDocId, {
        type: 'memory',
        text: f.fact,
        sourceId,
      }).catch((err: any) => strapi.log.warn(`[memory] edge extraction failed for ${sourceId}: "${f.fact.slice(0, 60)}" — ${err}`));
    }

    const edges = Array.isArray(parsed.edges) ? parsed.edges.slice(0, 3) : [];
    if (edges.length > 0) {
      try {
        const { upsertEdge } = await import('../../knowledge-graph');
        for (const e of edges) {
          if (!e.subject || !e.predicate || !e.object) continue;
          await upsertEdge(strapi, projectDocId, {
            subject: String(e.subject).toLowerCase().trim(),
            predicate: String(e.predicate).toLowerCase().trim(),
            object: String(e.object).toLowerCase().trim(),
            value: e.value ? String(e.value) : undefined,
          });
          strapi.log.info(`[memory] edge: ${e.subject} —${e.predicate}→ ${e.object}`);
        }
      } catch (err) {
        strapi.log.warn(`[memory] edge upsert failed: ${err}`);
      }
    }
  } catch (err) {
    strapi?.log?.warn?.(`[memory] extraction failed: ${err}`);
  }
}

/**
 * Extract and store GraphQL tool call patterns from a session.
 */
export async function extractToolPatterns(
  toolCalls: ToolCallRecord[],
  strapi: any,
  projectDocId: string,
): Promise<void> {
  const graphqlCalls = toolCalls.filter(
    (tc) => tc.name.includes('graphql') && !tc.isError && tc.result.length > 50,
  );

  for (const tc of graphqlCalls) {
    const query = (tc.input.query || tc.input.graphql_query || '') as string;
    if (!query) continue;

    const queryText = query.trim().slice(0, 200);
    const text = `GraphQL pattern: ${queryText}`;

    try {
      await addMemory(projectDocId, '__project__', 'tool_pattern', text, 'project', 'auto');
      strapi.log.debug(`[memory] tool_pattern stored: ${queryText.slice(0, 60)}`);
    } catch (err) {
      strapi.log.warn(`[memory] extractToolPatterns failed for call ${tc.id}: ${err}`);
    }
  }
}
