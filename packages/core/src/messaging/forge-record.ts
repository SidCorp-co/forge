/**
 * The one parse of the ```forge-record fence an agent writes on an issue.
 *
 * Both halves of ISS-1089 read this and nothing else: the comment-write door
 * screens the record field by field, and `comments/tree.ts` carries the same
 * parsed value onto the comment node so web-v2 can draw it. Two parsers that
 * can disagree is the defect that issue exists to replace.
 */

// cm:guard the grammar is the WRITER's, mirrored from `plugin/src/flow/machine.mjs` in
// github.com/SidCorp-co/forge-plugin (`OPEN`, `KEY`, `TAG`, `payloadIn`) rather than invented here.
// The two repos ship on different clocks and nothing in this one gates that one, so a reader
// changing any of the four constants below is changing this side of a pair whose other half is over
// there — check `payloadIn` before you do, and CLAUDE.md's carve-out for how a defect in it leaves.
const INFO = 'forge-record';
const OPEN = new RegExp(`^(\`{3,})${INFO}\\s*$`, 'u');
const KEY = /^([a-z][a-z0-9-]*): ?(.*)$/u;
const TAG = new RegExp(`^\`?${INFO}: ([a-z]+) · contract (\\d+)\`?\\s*$`, 'u');
const INDENTED = /^ {2}(.*)$/u;

/**
 * What one field of a record may hold before it is refused.
 */
// cm:guard the unit is the FIELD and there is deliberately no cap on the record as a whole: a
// global cap makes a writer trim whichever field is cheapest to cut rather than the one that
// outgrew its job (ISS-1089). The figure was measured before it was accepted — 37,305 real fields
// across 1,884 fenced comments on this project's last 180 issues, of which 4.8% exceed it, and
// every one of those is prose a writer can split rather than a machine-derived list it cannot.
export const FORGE_RECORD_FIELD_BUDGET = 400;

/**
 * The fields ISS-1089 asks a record to carry that contract 1 does not have.
 */
// cm:guard these are REQUESTED in forge-plugin and absent here on purpose. The parse reports them
// missing rather than inventing either from another field's text: a `lead` synthesised from the
// first sentence of `detail` would be screened for voice as though the writer had written it, and
// the writer would meet a refusal about a sentence it never composed.
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
 * Where the block ends: past a tag line following it, blank lines included.
 */
// cm:guard the tag is swallowed into the block deliberately. It is the record's own kind label and
// the CLI writes it one blank line below the closing fence; leaving it outside means a card drawn
// for the record and a stray `forge-record: verdict · contract 1` line drawn beside it as prose.
function endOf(lines: readonly string[], starts: readonly number[], closed: number): number {
  const endOfLine = (at: number) => (starts[at] ?? 0) + (lines[at] ?? '').length;
  for (let at = closed + 1; at < lines.length; at += 1) {
    const line = lines[at] ?? '';
    if (line.trim() === '') continue;
    return TAG.test(line.trim()) ? endOfLine(at) : endOfLine(closed);
  }
  return endOfLine(closed);
}

/**
 * The fenced block: its key/value pairs in the order written, and its extent.
 */
// cm:guard an INDENTED line continues the value above rather than opening a key, and an
// unrecognised line does the same — both are `payloadIn`'s behaviour and neither is a guess. A
// value's own second line is written two spaces in by `linesFor` over there, so reading it as a key
// would split one field into two the moment a writer used a newline.
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
      return { entries, at: starts[opens] ?? 0, to: endOf(lines, starts, at) };
    }
    const indented = INDENTED.exec(line);
    const key = indented ? null : KEY.exec(line);
    if (key) entries.push([key[1] as string, key[2] as string]);
    else if (entries.length) {
      const last = entries[entries.length - 1] as [string, string];
      last[1] += `\n${indented ? (indented[1] as string) : line}`;
    }
  }
  // cm:guard an unterminated fence is still a record and still screened: the writer left the block
  // open, and refusing to read it would let a record past the budget by dropping its closing line.
  return { entries, at: starts[opens] ?? 0, to: body.length };
}

/** The tag line naming the record's kind, wherever it sits in the body. */
function tagIn(body: string): { kind: string; contract: number } | null {
  for (const line of body.split('\n')) {
    const found = TAG.exec(line.trim());
    if (found) return { kind: found[1] as string, contract: Number(found[2]) };
  }
  return null;
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
  const tag = tagIn(text);
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
