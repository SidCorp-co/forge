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
  /** What storing the comment anyway would do, where it is not "carries no record at all". */
  readonly consequence?: string;
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
 * The next fence at or after `from` that opens a record block at top level. A fence inside another
 * fence is that fence's content, so an example quoted in prose opens nothing.
 */
function openerFrom(lines: readonly string[], from: number): Opener | null {
  let open: string | null = null;
  for (let at = from; at < lines.length; at += 1) {
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
 * Where the block ends, the tag line that ends it, and the line a scan for the next block resumes at.
 */
function endOf(
  lines: readonly string[],
  starts: readonly number[],
  closed: number,
): { to: number; next: number; tag: { kind: string; contract: number } | null } {
  const endOfLine = (at: number) => (starts[at] ?? 0) + (lines[at] ?? '').length;
  for (let at = closed + 1; at < lines.length; at += 1) {
    const line = lines[at] ?? '';
    if (line.trim() === '') continue;
    const found = TAG.exec(line.trim());
    if (!found) return { to: endOfLine(closed), next: closed + 1, tag: null };
    return {
      to: endOfLine(at),
      next: at + 1,
      tag: { kind: found[1] as string, contract: Number(found[2]) },
    };
  }
  return { to: endOfLine(closed), next: closed + 1, tag: null };
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

/** The line closing the fence `opener` opened, or null where nothing closes it. */
function closingLine(lines: readonly string[], opener: Opener): number | null {
  for (let at = opener.at + 1; at < lines.length; at += 1) {
    if (closes(lines[at] ?? '', opener.fence)) return at;
  }
  return null;
}

/**
 * What one opener yields, a block or why it carries none, and the line the scan resumes at: null
 * where the fence is never closed, since everything below it is its content.
 */
function blockAt(
  lines: readonly string[],
  starts: readonly number[],
  opener: Opener,
): { block: Block | null; fault: ForgeRecordFault | null; next: number | null } {
  const quote = lines[opener.at] as string;
  const closed = closingLine(lines, opener);
  if (closed === null) return { block: null, fault: { quote, why: NEVER_CLOSED }, next: null };
  const rest = opener.info.trim();
  const onFence = rest === '' ? null : TAG_ON_FENCE.exec(rest);
  if (rest !== '' && !onFence) {
    return { block: null, fault: { quote, why: UNREADABLE_INFO }, next: closed + 1 };
  }
  const fromFence = onFence ? { kind: onFence[1] as string, contract: Number(onFence[2]) } : null;
  const end = endOf(lines, starts, closed);
  if (
    fromFence &&
    end.tag &&
    (end.tag.kind !== fromFence.kind || end.tag.contract !== fromFence.contract)
  ) {
    return { block: null, fault: { quote, why: TAGS_DISAGREE }, next: end.next };
  }
  return {
    block: {
      entries: entriesFrom(lines, opener.at + 1, closed),
      tag: fromFence ?? end.tag,
      at: starts[opener.at] ?? 0,
      to: end.to,
    },
    fault: null,
    next: end.next,
  };
}

/**
 * Every record fence a body opens at top level, in the order written, each a block or why it
 * carries none. A fence never closed ends the scan: what follows it is its content.
 */
function blocksIn(body: string): { block: Block | null; fault: ForgeRecordFault | null }[] {
  const raw = body.split('\n');
  const lines = raw.map(typed);
  const starts = offsets(raw);
  const out: { block: Block | null; fault: ForgeRecordFault | null }[] = [];
  let from: number | null = 0;
  while (from !== null) {
    const opener = openerFrom(lines, from);
    if (!opener) break;
    const { block, fault, next } = blockAt(lines, starts, opener);
    const above = tagAbove(lines, from, opener.at);
    out.push(above === null ? { block, fault } : { block: null, fault: markerAbove(above) });
    from = next;
  }
  return out;
}

/**
 * A tag line standing above a fence, where no reader looks, that the block before it did not take
 * as its own closing tag: the line it sits on, or null. Read as written it tags no block, or tags
 * the block above as some other record; either way the record it was written for is never read.
 */
function tagAbove(lines: readonly string[], from: number, opener: number): string | null {
  for (let at = opener - 1; at >= from; at -= 1) {
    const line = (lines[at] ?? '').trim();
    if (line === '') continue;
    return TAG.test(line) ? line : null;
  }
  return null;
}

const markerAbove = (line: string): ForgeRecordFault => ({
  quote: line,
  why: `the tag line \`${line.replace(/^`|`$/gu, '')}\` sits above its \`forge-record\` fence, where no reader looks: it goes on the line after the closing fence, or on the opening fence itself (\`\`\`forge-record: <kind> · contract <n>)`,
  consequence:
    'so the record written under that fence would be read as another record or as none, and the comment is refused whole rather than stored half-read',
});

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

/**
 * One record fence of a body, read: `index` counts the body's top-level fences from 1, so a
 * refusal can name which one it means.
 */
export interface ForgeRecordRead {
  readonly index: number;
  readonly record: ForgeRecord | null;
  readonly fault: ForgeRecordFault | null;
}

/** Every record fence a body opens, read; a body that opened none answers `[]`, which is most. */
export function readForgeRecords(body: string | null | undefined): ForgeRecordRead[] {
  return blocksIn(String(body ?? '')).map(({ block, fault }, at) => ({
    index: at + 1,
    record: block ? recordFrom(block) : null,
    fault,
  }));
}

/**
 * The first fence's reading, for the read paths that draw one record per comment (the thread, the
 * park view, the one-time backfill). The write door reads every fence (`readForgeRecords`).
 */
export function readForgeRecord(body: string | null | undefined): Omit<ForgeRecordRead, 'index'> {
  const [first] = readForgeRecords(body);
  return { record: first?.record ?? null, fault: first?.fault ?? null };
}

export function parseForgeRecord(body: string | null | undefined): ForgeRecord | null {
  return readForgeRecord(body).record;
}
