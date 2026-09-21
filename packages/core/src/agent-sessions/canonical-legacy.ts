/** What a conversion answers with. */
export type CanonicalConversion =
  | { ok: true; entry: Record<string, unknown>; converted: boolean }
  | { ok: false; why: string };

/** The key the original entry is kept under when one was actually rewritten. */
export const LEGACY_ENTRY_KEY = '__legacyEntry';

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
    if (out.blocks === undefined) out.blocks = blocks;
  }

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
