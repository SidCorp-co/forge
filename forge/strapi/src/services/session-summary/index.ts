/**
 * Session Summary — summarize chat sessions and embed them in Qdrant
 * so past conversations surface in future RAG retrieval.
 */

import { upsertEmbedding } from '../embeddings';

const SUMMARY_PROMPT = `Extract the KEY OUTCOME of this conversation in 1-2 sentences (200-400 chars).

Rules:
- Focus on WHAT WAS RESOLVED or WHAT FAILED — not what was asked
- Include specific data points, names, or numbers from the result
- If the agent couldn't answer, say WHY (wrong query, missing data, timeout)
- If nothing useful happened (just greetings), respond with exactly: SKIP

Good: "Found 6 new candidates today using candidates(filters: {date_from, date_to, status_id: 2}). Displayed in table with name, phone, status."
Good: "Monthly overview failed — campaignStatistics query errored because from_date was passed as date_from. Agent retried 13 times and timed out."
Good: "Top 5 clients by campaign count: Công ty ABC (12), XYZ Corp (8), ... Retrieved via campaigns(first:100) grouped by primary_client."
Bad: "User asks about revenue per campaign" — this says nothing about the outcome.

Conversation:
{messages}

Outcome:`;

const MIN_USER_MESSAGES = 4;
const MIN_TOTAL_MESSAGES = 6;
const STALE_HOURS = 24;
const STALE_NEW_MESSAGES = 6;

interface SessionMessage {
  role: string;
  content: string;
}

/**
 * Check if a session has enough substance to warrant summarization.
 */
export function isSessionSummarizable(
  messages: SessionMessage[],
  metadata?: Record<string, any>,
): boolean {
  const userMessages = messages.filter((m) => m.role === 'user');
  if (userMessages.length < MIN_USER_MESSAGES) return false;

  const hasToolCalls = (metadata?.totalToolCalls || 0) > 0;
  if (hasToolCalls) return true;

  return messages.length >= MIN_TOTAL_MESSAGES;
}

/**
 * Check if an existing summary is stale and needs re-summarization.
 */
function isSummaryStale(
  session: any,
  currentMessageCount: number,
): boolean {
  if (!session.summarizedAt) return true;

  const hoursSince = (Date.now() - new Date(session.summarizedAt).getTime()) / (1000 * 60 * 60);
  if (hoursSince < STALE_HOURS) return false;

  // Re-summarize if conversation has grown significantly
  const prevCount = session.metadata?.summarizedMessageCount || 0;
  return (currentMessageCount - prevCount) >= STALE_NEW_MESSAGES;
}

/**
 * Summarize a session and embed it in Qdrant.
 * Designed to be called fire-and-forget after persistSession.
 */
export async function summarizeAndEmbed(
  strapi: any,
  sessionDocId: string,
  projectDocId: string,
  userKey: string,
): Promise<void> {
  try {
    const session = await strapi.documents('api::chat-session.chat-session').findOne({
      documentId: sessionDocId,
    });
    if (!session) return;

    const messages: SessionMessage[] = session.messages || [];
    if (!isSessionSummarizable(messages, session.metadata)) return;
    if (!isSummaryStale(session, messages.length)) return;

    // Build conversation text for summarization (last 20 messages max)
    const recent = messages.slice(-20);
    const messagesStr = recent
      .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 300) : '[complex]'}`)
      .join('\n');

    const apiUrl = process.env.LITELLM_API_URL;
    const apiKey = process.env.LITELLM_API_KEY;
    if (!apiUrl) return;

    const prompt = SUMMARY_PROMPT.replace('{messages}', messagesStr);

    const response = await fetch(`${apiUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
      },
      body: JSON.stringify({
        model: process.env.LITELLM_FAST_MODEL || process.env.LITELLM_MODEL || 'gemini-flash',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300,
        temperature: 0,
      }),
    });

    if (!response.ok) {
      strapi.log.warn(`[session-summary] LLM call failed: ${response.status}`);
      return;
    }

    const data = (await response.json()) as any;
    const summary = (data.choices?.[0]?.message?.content || '').trim();

    if (!summary || summary.length < 20) {
      strapi.log.warn(`[session-summary] Summary too short, skipping`);
      return;
    }

    // Filter non-actionable summaries
    if (/^SKIP$/i.test(summary.trim())) {
      strapi.log.info(`[session-summary] Session ${sessionDocId} — no actionable outcome, skipping`);
      return;
    }
    const garbagePatterns = [
      /^I cannot/i,
      /^I can't/i,
      /^I'm unable/i,
      /^Sorry,?\s+I/i,
      /^As an AI/i,
      /without (its |the )?actual/i,
      /cannot summarize/i,
      /no conversation/i,
      /^(The )?user (asks|inquires|requests|wants)[\s\w]{0,30}$/i,  // short vague restatement (no outcome)
    ];
    if (garbagePatterns.some((p) => p.test(summary))) {
      strapi.log.warn(`[session-summary] Non-actionable summary filtered: "${summary.slice(0, 60)}"`);
      return;
    }

    // Save summary to session
    const now = new Date().toISOString();
    await strapi.documents('api::chat-session.chat-session').update({
      documentId: sessionDocId,
      data: {
        summary,
        summarizedAt: now,
        metadata: {
          ...(session.metadata || {}),
          summarizedMessageCount: messages.length,
        },
      },
    });

    // Embed in Qdrant
    await upsertEmbedding({
      project_id: projectDocId,
      source_type: 'chat_session',
      source_id: sessionDocId,
      text: summary,
      metadata: {
        title: session.title,
        userKey,
        messageCount: messages.length,
        summarizedAt: now,
      },
    });

    strapi.log.info(`[session-summary] Summarized session ${sessionDocId} (${messages.length} messages, ${summary.length} chars)`);
  } catch (err) {
    strapi.log.warn(`[session-summary] Failed: ${err}`);
  }
}
