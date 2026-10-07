// The reads a room repeats turn after turn — a guide, the project's knowledge, its memory — served
// from the room's own earlier read for a while instead of paid for again (chat mining 2026-10-07:
// 43% of turns read knowledge, 40% memory and 20% a guide before answering, every turn). Tracker
// reads are never cached: what an issue says now is what a reply must say.

import type { CallToolResult } from '../../lib/tool-result.js';
import type { ChatToolset } from './mcp-adapter.js';

const TTL_MS = 10 * 60 * 1000;
const ROOMS = 200;
const ENTRIES_PER_ROOM = 40;
const KNOWLEDGE_READS: ReadonlySet<string> = new Set(['list', 'get', 'search']);
/** A write that changes what a cached read would return clears the room's reads. */
const CLEARING_TOOLS: ReadonlySet<string> = new Set(['forge_memory_note']);

interface Held {
  readonly at: number;
  readonly result: CallToolResult;
}

const rooms = new Map<string, Map<string, Held>>();

function parsed(argsJson: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(argsJson || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted);
  if (!v || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(o)
      .sort()
      .map((k) => [k, sorted(o[k])]),
  );
}

/** The key a cacheable read is held under, or null for a call that must run every time. */
export function readCacheKey(name: string, argsJson: string): string | null {
  const args = parsed(argsJson);
  if (!args) return null;
  const canonical = `${name} ${JSON.stringify(sorted(args))}`;
  if (name === 'forge_knowledge')
    return KNOWLEDGE_READS.has(String(args.action)) ? canonical : null;
  if (name === 'forge_memory') return args.action === 'search' ? canonical : null;
  if (name !== 'forge' || !Array.isArray(args.argv) || args.body !== undefined) return null;
  const [verb, sub] = args.argv as unknown[];
  if (verb === 'guide') return canonical;
  if (verb === 'knowledge' && KNOWLEDGE_READS.has(String(sub))) return canonical;
  return null;
}

function roomOf(conversationId: string): Map<string, Held> {
  let room = rooms.get(conversationId);
  if (room) {
    rooms.delete(conversationId);
    rooms.set(conversationId, room);
    return room;
  }
  room = new Map();
  rooms.set(conversationId, room);
  while (rooms.size > ROOMS) rooms.delete(rooms.keys().next().value as string);
  return room;
}

const servedNote = (at: number): string =>
  `(Served from this conversation's own read at ${new Date(at).toISOString()}; the same read is not repeated within ${TTL_MS / 60_000} minutes.)`;

/**
 * The toolset with the room's repeated reads served from its earlier read. A refused read is
 * never held, and a note written to memory clears what the room held.
 */
export function cachedReads(
  conversationId: string | null,
  tools: ChatToolset | undefined,
  now: () => number = Date.now,
): ChatToolset | undefined {
  if (!tools || !conversationId) return tools;
  return {
    ...tools,
    async execute(name, argsJson) {
      const key = readCacheKey(name, argsJson);
      if (key === null) {
        if (CLEARING_TOOLS.has(name)) rooms.delete(conversationId);
        return tools.execute(name, argsJson);
      }
      const room = roomOf(conversationId);
      const held = room.get(key);
      if (held && now() - held.at < TTL_MS) {
        return {
          ...held.result,
          content: [{ type: 'text', text: servedNote(held.at) }, ...held.result.content],
        };
      }
      const result = await tools.execute(name, argsJson);
      if (result.isError) return result;
      room.delete(key);
      room.set(key, { at: now(), result });
      while (room.size > ENTRIES_PER_ROOM) room.delete(room.keys().next().value as string);
      return result;
    },
  };
}
