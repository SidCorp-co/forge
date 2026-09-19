const INFO = 'forge-record';
const OPEN = new RegExp(`^(\`{3,})${INFO}\\s*$`, 'u');
const KEY = /^([a-z][a-z0-9-]*): ?(.*)$/u;
const TAG = new RegExp(`^\`?${INFO}: ([a-z]+) · contract (\\d+)\`?\\s*$`, 'u');
const INDENTED = /^ {2}(.*)$/u;

/**
 * What one field of a record may hold before it is refused.
 */
export const FORGE_RECORD_FIELD_BUDGET = 400;

/**
 * The fields ISS-1089 asks a record to carry that contract 1 does not have.
 */
export const REQUESTED_FIELDS: readonly string[] = ['lead', 'beside'];

export interface ForgeRecordField {
  readonly key: string;
  readonly value: string;
  /** Characters past `FORGE_RECORD_FIELD_BUDGET`, or 0 where it is within it. */
  readonly over: number;
}

export interface ForgeRecord {
  /** The kind named by the tag line, or null where the fence carries no tag. */
  readonly kind: string | null;
  readonly contract: number | null;
  /** Every key in the order written; a key repeated in one fence is a repeated field. */
  readonly fields: readonly ForgeRecordField[];
  /** The `lead` field's text, or null where the record carries none. */
  readonly lead: string | null;
  /** Which of `REQUESTED_FIELDS` this record does not carry. */
  readonly absent: readonly string[];
  /** Where the block starts in the body, so a reader can draw the prose before it. */
  readonly at: number;
  /** Where it ends, past the tag line where one follows. */
  readonly to: number;
}

interface Block {
  readonly entries: [string, string][];
  readonly tag: { kind: string; contract: number } | null;
  readonly at: number;
  readonly to: number;
}

/** The offset each line starts at, so a block can say where it sits in the body. */
function offsets(lines: readonly string[]): number[] {
  const out: number[] = [];
  let at = 0;
  for (const line of lines) {
    out.push(at);
    at += line.length + 1;
  }
  return out;
}

/**
 * Where the block ends, and the tag that ends it.
 */
function endOf(
  lines: readonly string[],
  starts: readonly number[],
  closed: number,
): { to: number; tag: { kind: string; contract: number } | null } {
  const endOfLine = (at: number) => (starts[at] ?? 0) + (lines[at] ?? '').length;
  for (let at = closed + 1; at < lines.length; at += 1) {
    const line = lines[at] ?? '';
    if (line.trim() === '') continue;
    const found = TAG.exec(line.trim());
    if (!found) return { to: endOfLine(closed), tag: null };
    return {
      to: endOfLine(at),
      tag: { kind: found[1] as string, contract: Number(found[2]) },
    };
  }
  return { to: endOfLine(closed), tag: null };
}

/**
 * The fenced block: its key/value pairs in the order written, and its extent.
 */
function blockIn(body: string): Block | null {
  const lines = body.split('\n');
  const starts = offsets(lines);
  const opens = lines.findIndex((line) => OPEN.test(line));
  if (opens < 0) return null;
  const fence = OPEN.exec(lines[opens] ?? '')?.[1] ?? '```';
  const entries: [string, string][] = [];
  for (let at = opens + 1; at < lines.length; at += 1) {
    const line = lines[at] ?? '';
    if (line.trim().startsWith(fence)) {
      const end = endOf(lines, starts, at);
      return { entries, tag: end.tag, at: starts[opens] ?? 0, to: end.to };
    }
    const indented = INDENTED.exec(line);
    const key = indented ? null : KEY.exec(line);
    if (key) entries.push([key[1] as string, key[2] as string]);
    else if (entries.length) {
      const last = entries[entries.length - 1] as [string, string];
      last[1] += `\n${indented ? (indented[1] as string) : line}`;
    }
  }
  return { entries, tag: null, at: starts[opens] ?? 0, to: body.length };
}

/** How far past the budget a value runs, counted in code points as the caps are. */
export function overBudget(value: string): number {
  return Math.max(0, [...value].length - FORGE_RECORD_FIELD_BUDGET);
}

/**
 * The record a comment body carries, or null where it carries no fence.
 */
export function parseForgeRecord(body: string | null | undefined): ForgeRecord | null {
  const text = String(body ?? '');
  const block = blockIn(text);
  if (!block) return null;
  const tag = block.tag;
  const fields = block.entries.map(([key, value]) => ({
    key,
    value,
    over: overBudget(value),
  }));
  const held = new Set(fields.map((f) => f.key));
  return {
    kind: tag?.kind ?? null,
    contract: tag?.contract ?? null,
    fields,
    lead: fields.find((f) => f.key === 'lead')?.value ?? null,
    absent: REQUESTED_FIELDS.filter((key) => !held.has(key)),
    at: block.at,
    to: block.to,
  };
}
