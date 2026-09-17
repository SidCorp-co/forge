/**
 * ISS-1030 — the one conversion from a legacy `role`/`contentBlocks` transcript
 * entry to the canonical one.
 *
 * Two shapes used to coexist in `agent_sessions.messages`: the desktop runner
 * and edited turns wrote `role` + `contentBlocks`, the derive writes `type` +
 * ordered `blocks`. Two readers existed to read both. This file is what lets
 * those readers lose their branch, and it has exactly one implementation on
 * purpose: the backfill migration calls it, and so does the live amnesty on
 * `PATCH /api/agent-sessions/:id`, because a converter the migration used and the
 * live door did not would let an un-upgraded daemon write entries nothing left
 * in the product could read.
 *
 * A row it cannot represent is REFUSED by name. It is never dropped, never
 * guessed at, and never widened to fit: the migration aborts naming the entry
 * and the PATCH answers 400 naming the entry, because an entry quietly discarded
 * to make a deploy succeed is a person's conversation gone missing.
 */

/** What a conversion answers with. */
export type CanonicalConversion =
  | { ok: true; entry: Record<string, unknown>; converted: boolean }
  | { ok: false; why: string };

/** The key the original entry is kept under when one was actually rewritten. */
// cm:guard the original is KEPT, and that is what makes the migration's inverse a
// rewrite rather than a guess: the backfill edits `agent_sessions.messages` in
// place, so restoring the legacy readers does not restore the rows, and the
// inverse has to put back what stood rather than re-derive it from the canonical
// form. Dropping this key makes the rollback lossy, which is the one property
// `The way back` on this issue is built on.
export const LEGACY_ENTRY_KEY = '__legacyEntry';

/**
 * The five kinds a canonical entry may be, and the whole of what the readers
 * left in the product can draw.
 *
 * cm:edge lockstep -> packages/core/src/agent-sessions/turns-helpers.ts — `messageRoleToTurnRole`
 * cm:edge lockstep -> packages/web-v2/src/features/session/types.ts — `entryRole`
 * cm:edge lockstep -> packages/core/src/lib/agent-stream-parser.ts — `AgentMessage['type']`, the producer
 */
export const CANONICAL_ENTRY_TYPES = [
  'user',
  'assistant',
  'system',
  'tool_use',
  'tool_result',
] as const;

const CANONICAL_TYPES: ReadonlySet<string> = new Set(CANONICAL_ENTRY_TYPES);

const ROLE_TO_TYPE: Readonly<Record<string, string>> = {
  user: 'user',
  assistant: 'assistant',
  system: 'system',
  // cm:why a legacy `role: 'tool'` becomes `tool_result` rather than `tool_use`:
  // both map to the same turn role on both sides (`turns-helpers.ts` and the web
  // formatter fold `system`, `tool_use` and `tool_result` into `tool`), so the
  // two readings render identically, and `tool_result` is the one that carries
  // captured output — which is what a stored legacy tool entry holds.
  tool: 'tool_result',
};

/** One legacy `contentBlocks` member as the canonical `blocks` member. */
function convertBlock(
  block: unknown,
  at: string,
): { ok: true; block: unknown } | { ok: false; why: string } {
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    return { ok: false, why: `${at} is not an object` };
  }
  const b = block as Record<string, unknown>;
  const type = b.type;
  if (type === 'text') return { ok: true, block: { type: 'text', text: b.text } };
  if (type === 'todos') return { ok: true, block: { type: 'todos', todos: b.todos } };
  if (type === 'tool_use') return { ok: true, block: { type: 'tool', toolCall: b.tool } };
  // Already canonical members pass through untouched — a mixed array is a real
  // shape on disk, because an edited turn kept its neighbours as they were.
  if (type === 'tool' || type === 'thinking') return { ok: true, block: b };
  return {
    ok: false,
    why: `${at} has block type ${JSON.stringify(type)}, which the canonical shape has no member for`,
  };
}

/**
 * One transcript entry in the canonical shape.
 *
 * `converted` says whether anything was rewritten, so a caller can tell an entry
 * that was already canonical from one this call changed — which is what lets the
 * backfill leave a canonical row untouched instead of stamping a legacy copy
 * onto it.
 */
export function toCanonicalEntry(raw: unknown): CanonicalConversion {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      why: `entry is ${Array.isArray(raw) ? 'an array' : typeof raw}, not an object`,
    };
  }
  const entry = raw as Record<string, unknown>;
  const hasRole = entry.role !== undefined;
  const hasLegacyBlocks = Array.isArray(entry.contentBlocks);
  // cm:guard an entry carrying neither legacy field is NOT canonical by
  // elimination — it is canonical when its `type` names one of the five kinds,
  // and `{ content: 'hello' }` or `{ type: 'moderator' }` names none of them.
  // Passing those through as "already canonical" is the silent substitution this
  // file exists to refuse: `messageRoleToTurnRole` answers null for them, the
  // turn sync drops them, and a person's line leaves the conversation with a 200
  // on the wire. The refusal is the deliverable — the caller is told which entry
  // and what a valid one looks like.
  if (!hasRole && !hasLegacyBlocks) {
    const type = entry.type;
    if (typeof type !== 'string' || !CANONICAL_TYPES.has(type)) {
      return {
        ok: false,
        why: `entry has \`type: ${JSON.stringify(type)}\`, which names no canonical kind (${CANONICAL_ENTRY_TYPES.join(', ')})`,
      };
    }
    return { ok: true, entry, converted: false };
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'role' || key === 'contentBlocks') continue;
    out[key] = value;
  }

  if (hasRole) {
    const role = entry.role;
    if (typeof role !== 'string') {
      return {
        ok: false,
        why: `entry has a \`role\` of type ${typeof role}, which names no canonical kind`,
      };
    }
    const type = ROLE_TO_TYPE[role];
    if (!type) {
      return {
        ok: false,
        why: `entry has \`role: ${JSON.stringify(role)}\`, which names no canonical kind`,
      };
    }
    // cm:guard an entry carrying BOTH `role` and `type` keeps its `type`: the
    // derive wrote that one, and a `role` beside it is the older reader's
    // annotation rather than a second claim about what the entry is.
    if (out.type === undefined) out.type = type;
  }

  if (hasLegacyBlocks) {
    const blocks: unknown[] = [];
    const legacy = entry.contentBlocks as unknown[];
    for (let i = 0; i < legacy.length; i += 1) {
      const converted = convertBlock(legacy[i], `contentBlocks[${i}]`);
      if (!converted.ok) return { ok: false, why: converted.why };
      blocks.push(converted.block);
    }
    // cm:guard canonical `blocks` already on the entry WIN. An entry that has
    // both is one the derive wrote and something older annotated; rebuilding its
    // ordered blocks from the annotation would put the derive's interleaving back
    // to the flattened one.
    if (out.blocks === undefined) out.blocks = blocks;
  }

  // cm:guard the same check on the way OUT: a legacy entry carrying
  // `contentBlocks` and no `role` reaches here with whatever `type` it already
  // had, which may be none. A rewrite that produces an entry the readers cannot
  // draw is the thing this conversion exists to prevent, so it is refused with
  // the same sentence rather than stored because it passed through a converter.
  const producedType = out.type;
  if (typeof producedType !== 'string' || !CANONICAL_TYPES.has(producedType)) {
    return {
      ok: false,
      why: `entry converts to \`type: ${JSON.stringify(producedType)}\`, which names no canonical kind (${CANONICAL_ENTRY_TYPES.join(', ')})`,
    };
  }

  out[LEGACY_ENTRY_KEY] = entry;
  return { ok: true, entry: out, converted: true };
}

/** The entry this canonical one was rewritten from, or null where it is not a rewrite. */
export function legacyEntryOf(entry: unknown): unknown {
  if (!entry || typeof entry !== 'object') return null;
  return (entry as Record<string, unknown>)[LEGACY_ENTRY_KEY] ?? null;
}

/** What a whole `messages` array converts to, refusing by INDEX so the caller can name the row. */
export type CanonicalMessages =
  | { ok: true; messages: Record<string, unknown>[]; converted: number }
  | { ok: false; index: number; why: string };

export function toCanonicalMessages(raw: unknown): CanonicalMessages {
  if (!Array.isArray(raw)) {
    return { ok: false, index: -1, why: `messages is ${typeof raw}, not an array` };
  }
  const messages: Record<string, unknown>[] = [];
  let converted = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const result = toCanonicalEntry(raw[i]);
    if (!result.ok) return { ok: false, index: i, why: result.why };
    if (result.converted) converted += 1;
    messages.push(result.entry);
  }
  return { ok: true, messages, converted };
}
