/**
 * The one way a turn asks its room about its own past (ISS-1090).
 *
 * The room and the caller are closed over, so the model names neither and
 * cannot ask about a room it is not in. Every bound is spent in
 * `searchConversationTranscript` or here, never declared at the model in a JSON
 * schema and hoped for. A refusal from the room's fence comes back as the
 * fence's own sentence rather than as an empty page.
 */

import { type ChatToolset, toolError } from '../assistant/tools/mcp-adapter.js';
import type { CallToolResult } from '../mcp/tool-result.js';
import { RETRIEVAL_MAX_RESULTS, searchConversationTranscript } from './transcript-search.js';

export const TRANSCRIPT_SEARCH_TOOL_NAME = 'conversation_transcript_search';
/** Calls one turn may spend on it. */
export const SEARCH_MAX_CALLS_PER_TURN = 3;
/** Characters of a query this reads; a longer one is refused rather than silently cut. */
export const SEARCH_QUERY_CAP = 300;

/** Turns a message's transport id into a link the room can follow, or null. */
export type PermalinkResolver = (externalId: string) => Promise<string | null>;

export interface TranscriptSearchToolOptions {
  conversationId: string;
  /** Whose authority this turn runs under; the room's fence is asked about them. */
  principalUserId: string | null | undefined;
  permalink?: PermalinkResolver | undefined;
  /** What this conversation does NOT cover, in the venue's own terms. */
  venueLimitation?: string | null | undefined;
}

/** A tool's JSON arguments as an object, or the refusal a caller is owed. */
// cm:guard `null` and a bare scalar are valid JSON and not an object, and a read of `.query` off them throws out of the tool instead of refusing by name — the same guard every adapter's own `readToolArgs` carries, for the same reason.
function readArgs(argsJson: string): { args: Record<string, unknown> } | { error: string } {
  if (!argsJson.trim()) return { args: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return { error: 'arguments were not valid JSON' };
  }
  if (parsed === null || typeof parsed !== 'object')
    return { error: 'arguments were not a JSON object' };
  return { args: parsed as Record<string, unknown> };
}

/**
 * Build the room's transcript-search tool.
 */
// cm:guard the CONVERSATION and the PRINCIPAL are closed over and are not parameters: a room id the model could name is a room the model could name somebody else's, and the fence would then be the only thing between a turn and another room's text. A bound the model is asked to keep is not a bound, so the call budget lives in this closure and the result bounds live in the search (ISS-1090 rule 6).
export function buildTranscriptSearchToolset(opts: TranscriptSearchToolOptions): ChatToolset {
  let calls = 0;

  const execute = async (name: string, argsJson: string): Promise<CallToolResult> => {
    if (name !== TRANSCRIPT_SEARCH_TOOL_NAME) return toolError(`unknown tool "${name}"`);
    calls += 1;
    if (calls > SEARCH_MAX_CALLS_PER_TURN) {
      return toolError(
        `${TRANSCRIPT_SEARCH_TOOL_NAME} is capped at ${SEARCH_MAX_CALLS_PER_TURN} calls per turn — answer with what you have`,
      );
    }
    const read = readArgs(argsJson);
    if ('error' in read) return toolError(read.error);
    const query = typeof read.args.query === 'string' ? read.args.query.trim() : '';
    if (!query) return toolError(`${TRANSCRIPT_SEARCH_TOOL_NAME} needs a non-empty \`query\``);
    // cm:guard a long query is REFUSED and never cut to fit: a clipped query is a different question, and answering it as though it were the one asked is the silent substitution this whole file exists to avoid.
    if (query.length > SEARCH_QUERY_CAP) {
      return toolError(
        `${TRANSCRIPT_SEARCH_TOOL_NAME} takes a query of at most ${SEARCH_QUERY_CAP} characters and this one is ${query.length}; ask a shorter question rather than a cut one`,
      );
    }

    try {
      const result = await searchConversationTranscript({
        conversationId: opts.conversationId,
        userId: opts.principalUserId,
        query,
        ...(typeof read.args.limit === 'number' ? { limit: read.args.limit } : {}),
        ...(opts.venueLimitation ? { venueLimitation: opts.venueLimitation } : {}),
      });
      return { content: [{ type: 'text', text: JSON.stringify(await withLinks(result, opts)) }] };
    } catch (err) {
      // cm:guard the FENCE's own sentence reaches the model, because it names which of the four refusals this was — no authority, no scope, out of scope, not in the room — and a turn told "nothing matched" would go on to answer from the room it cannot read as though the room were empty (ISS-1090 rule 1).
      return toolError(refusalText(err));
    }
  };

  return {
    tools: [
      {
        type: 'function',
        function: {
          name: TRANSCRIPT_SEARCH_TOOL_NAME,
          description: `Search THIS room's older messages by topic and get back the passages that match, with links to them. Use it when the discussion refers to something decided or discussed before, which paging back through recent history would not find. Returns at most ${RETRIEVAL_MAX_RESULTS} passages a call and at most ${SEARCH_MAX_CALLS_PER_TURN} calls a turn. It reads only what has been indexed; the reply says how far that reaches and what it could not show.`,
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'What to look for, in the words the room would have used.',
              },
              limit: {
                type: 'number',
                description: `How many passages (1-${RETRIEVAL_MAX_RESULTS}).`,
              },
            },
            required: ['query'],
            additionalProperties: false,
          },
        },
      },
    ],
    execute,
  };
}

function refusalText(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string') {
    return err.message;
  }
  return 'this room could not be searched';
}

/**
 * Attach a link to every source the venue can build one for.
 */
// cm:guard a source with no usable transport id gets NO link and the search's own limitation already names it: inventing a room-level link for a message nobody can address would send a person to the top of a six-month channel and call it a citation (ISS-1090 rule 6).
async function withLinks(
  result: Awaited<ReturnType<typeof searchConversationTranscript>>,
  opts: TranscriptSearchToolOptions,
): Promise<unknown> {
  if (!opts.permalink) return result;
  const resolve = opts.permalink;
  const matches = await Promise.all(
    result.matches.map(async (m) => ({
      ...m,
      sources: await Promise.all(
        m.sources.map(async (s) => {
          const link = s.externalId ? await resolve(s.externalId).catch(() => null) : null;
          return link ? { ...s, link } : s;
        }),
      ),
    })),
  );
  return { ...result, matches };
}
