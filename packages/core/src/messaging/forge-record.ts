const INFO = 'forge-record';
/** Any fence line, either character but never mixed, so a scan can tell an opener from content. */
const FENCE_LINE = /^(`{3,}|~{3,})(.*)$/u;
/** The info string of a fence that means a record: the tag, and whatever follows it. */
const RECORD_INFO = new RegExp(`^${INFO}(?![\\w-])(.*)$`, 'u');
const KEY = /^([a-z][a-z0-9-]*): ?(.*)$/u;
const TAG = new RegExp(`^\`?${INFO}: ([a-z]+) · contract (\\d+)\`?\\s*$`, 'u');
/** The same tag carried on the opening fence, which is where a markdown writer puts it. */
const TAG_ON_FENCE = /^: ([a-z]+) · contract (\d+)$/u;
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
  /** The kind named by the tag, or null where the fence carries none. */
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

/**
 * Why a body that opened a record fence carries no record.
 */
export interface ForgeRecordFault {
  /** The line that opened it, so whoever wrote it sees what was read. */
  readonly quote: string;
  readonly why: string;
}

/**
 * What a body says about a record: one arm or the other, never both and never neither.
 */
export interface ForgeRecordRead {
  readonly record: ForgeRecord | null;
  readonly fault: ForgeRecordFault | null;
}

const UNREADABLE_INFO =
  'the fence opens a `forge-record` block and carries something after the tag that is not a tag';
const NEVER_CLOSED = 'the `forge-record` fence is opened and never closed';
const TAGS_DISAGREE =
  'the fence names one kind and the tag line after it names another, so neither can be taken';

interface Block {
  readonly entries: [string, string][];
  readonly tag: { kind: string; contract: number } | null;
  readonly at: number;
  readonly to: number;
}

interface Opener {
  readonly at: number;
  readonly fence: string;
  readonly info: string;
}

function typed(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
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
 * A line closing a fence: the same character, at least as many, indented no more than the three
 * spaces markdown allows. Past that it is content, and a field may hold it.
 */
function closes(line: string, fence: string): boolean {
  const found = /^ {0,3}(`+|~+)[ \t]*$/u.exec(line);
  const run = found?.[1];
  return run !== undefined && run[0] === fence[0] && run.length >= fence.length;
}

/**
 * The first fence that opens a record block at top level. A fence inside another
 * fence is that fence's content, so an example quoted in prose opens nothing.
 */
function openerIn(lines: readonly string[]): Opener | null {
  let open: string | null = null;
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at] ?? '';
    if (open) {
      if (closes(line, open)) open = null;
      continue;
    }
    const found = FENCE_LINE.exec(line);
    if (!found) continue;
    const fence = found[1] as string;
    const record = fence.startsWith('`') ? RECORD_INFO.exec(found[2] as string) : null;
    if (record) return { at, fence, info: record[1] as string };
    open = fence;
  }
  return null;
}

/**
 * Where the block ends, and the tag line that ends it.
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

/** The key/value pairs the block holds, in the order written. */
function entriesFrom(lines: readonly string[], from: number, to: number): [string, string][] {
  const entries: [string, string][] = [];
  for (let at = from; at < to; at += 1) {
    const line = lines[at] ?? '';
    const indented = INDENTED.exec(line);
    const key = indented ? null : KEY.exec(line);
    if (key) entries.push([key[1] as string, key[2] as string]);
    else if (entries.length) {
      const last = entries[entries.length - 1] as [string, string];
      last[1] += `\n${indented ? (indented[1] as string) : line}`;
    }
  }
  return entries;
}

/**
 * The fenced block a body carries, or why it carries none although it opened one.
 */
function blockIn(body: string): { block: Block | null; fault: ForgeRecordFault | null } {
  const raw = body.split('\n');
  const lines = raw.map(typed);
  const opener = openerIn(lines);
  if (!opener) return { block: null, fault: null };
  const starts = offsets(raw);
  const quote = lines[opener.at] as string;
  const rest = opener.info.trim();
  const onFence = rest === '' ? null : TAG_ON_FENCE.exec(rest);
  if (rest !== '' && !onFence) return { block: null, fault: { quote, why: UNREADABLE_INFO } };
  const fromFence = onFence ? { kind: onFence[1] as string, contract: Number(onFence[2]) } : null;
  for (let at = opener.at + 1; at < lines.length; at += 1) {
    if (!closes(lines[at] ?? '', opener.fence)) continue;
    const end = endOf(lines, starts, at);
    if (
      fromFence &&
      end.tag &&
      (end.tag.kind !== fromFence.kind || end.tag.contract !== fromFence.contract)
    ) {
      return { block: null, fault: { quote, why: TAGS_DISAGREE } };
    }
    return {
      block: {
        entries: entriesFrom(lines, opener.at + 1, at),
        tag: fromFence ?? end.tag,
        at: starts[opener.at] ?? 0,
        to: end.to,
      },
      fault: null,
    };
  }
  return { block: null, fault: { quote, why: NEVER_CLOSED } };
}

/** How far past the budget a value runs, counted in code points as the caps are. */
export function overBudget(value: string): number {
  return Math.max(0, [...value].length - FORGE_RECORD_FIELD_BUDGET);
}

function recordFrom(block: Block): ForgeRecord {
  const fields = block.entries.map(([key, value]) => ({
    key,
    value,
    over: overBudget(value),
  }));
  const held = new Set(fields.map((f) => f.key));
  return {
    kind: block.tag?.kind ?? null,
    contract: block.tag?.contract ?? null,
    fields,
    lead: fields.find((f) => f.key === 'lead')?.value ?? null,
    absent: REQUESTED_FIELDS.filter((key) => !held.has(key)),
    at: block.at,
    to: block.to,
  };
}

/** Both arms at once; a body that opened no fence has neither, which is most comments. */
export function readForgeRecord(body: string | null | undefined): ForgeRecordRead {
  const { block, fault } = blockIn(String(body ?? ''));
  return { record: block ? recordFrom(block) : null, fault };
}

export function parseForgeRecord(body: string | null | undefined): ForgeRecord | null {
  return readForgeRecord(body).record;
}
