/**
 * The identity a verdict block names, and what the write door refuses a block for naming none.
 *
 * A verdict is a claim about a runtime at a moment. A block that names no identity keeps the claim
 * and drops the moment, and nothing downstream can tell a verdict taken against what is running
 * from one taken against code that is gone. So the name is required here, where whoever wrote it is
 * still there to be told, rather than inferred later from wording.
 */

import type { MessageRefusal } from './contract.js';
import type { ForgeRecord } from './forge-record.js';

/** The field a criterion block names the runtime it held in, and the one it names its source in. */
export const RUNTIME_FIELD = 'runtime';
export const SOURCE_FIELD = 'commit';

/** Seven is the shortest abbreviation git mints; forty is a whole object id. */
export const SHORTEST_ABBREVIATION = 7;
export const SHORTEST_WHOLE_IDENTITY = 40;

const HEXADECIMAL = /^[0-9a-f]+$/iu;

const RULE = 'verdict-identity';

const SHAPE =
  'a criterion block of a `verdict` record names what it was judged against: `runtime: <a whole object id>` for an identity something was observed serving, or `commit: <at least seven hex characters>` for a source that was read';

const EXAMPLE = [
  '```forge-record: verdict · contract 1',
  'criterion: 13',
  'verdict: pass',
  'runtime: 33637c612ef15be6f924520c0d201a0889d8ed7e',
  '```',
].join('\n');

/** Whether a value is written as an identity at all. Every door asks this one question. */
export function recognisableIdentity(value: string | null | undefined): boolean {
  const trimmed = String(value ?? '').trim();
  return trimmed.length >= SHORTEST_ABBREVIATION && HEXADECIMAL.test(trimmed);
}

/** Whether a value is a whole object id rather than an abbreviation of one. */
export function wholeIdentity(value: string | null | undefined): boolean {
  const trimmed = String(value ?? '').trim();
  return trimmed.length >= SHORTEST_WHOLE_IDENTITY && HEXADECIMAL.test(trimmed);
}

/**
 * Whether two written identities name the same thing.
 *
 * `abbreviating` admits an abbreviation on either side. It is passed for a source, where the answer
 * chooses between two readings neither of which is earned, and withheld for a runtime, where an
 * abbreviation of the serving identity would let a verdict taken somewhere else read as standing.
 */
export function sameIdentity(
  a: string | null | undefined,
  b: string | null | undefined,
  { abbreviating = false }: { abbreviating?: boolean } = {},
): boolean {
  const left = String(a ?? '')
    .trim()
    .toLowerCase();
  const right = String(b ?? '')
    .trim()
    .toLowerCase();
  if (left === '' || right === '') return false;
  if (left === right) return true;
  if (!abbreviating) return false;
  if (!recognisableIdentity(left) || !recognisableIdentity(right)) return false;
  return left.startsWith(right) || right.startsWith(left);
}

export interface CriterionBlock {
  readonly criterion: number;
  readonly verdict: string | null;
  readonly runtime: string | null;
  readonly source: string | null;
}

interface OpenBlock {
  criterion: number;
  verdict: string | null;
  runtime: string | null;
  source: string | null;
}

/**
 * The criterion blocks a `verdict`-kind record holds, in the order written.
 *
 * A `criterion` line opens a block and closes the one before it, so a field belongs to the
 * criterion above it and never to a later one. A record of any other kind holds none.
 */
export function criterionBlocksIn(record: ForgeRecord | null): CriterionBlock[] {
  if (record?.kind !== 'verdict') return [];
  const out: CriterionBlock[] = [];
  let block: OpenBlock | null = null;
  const close = () => {
    if (block) out.push({ ...block });
    block = null;
  };
  for (const field of record.fields) {
    const value = field.value.trim();
    if (field.key === 'criterion') {
      close();
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n)) {
        block = { criterion: n, verdict: null, runtime: null, source: null };
      }
      continue;
    }
    if (!block) continue;
    if (field.key === 'verdict' && block.verdict === null) block.verdict = value;
    else if (field.key === RUNTIME_FIELD && block.runtime === null) block.runtime = value;
    else if (field.key === SOURCE_FIELD && block.source === null) block.source = value;
  }
  close();
  return out;
}

function refusal(why: string, quote: string): MessageRefusal {
  return { rule: RULE, why, quote, shape: SHAPE, example: EXAMPLE };
}

function refusalsForBlock(block: CriterionBlock): MessageRefusal[] {
  const out: MessageRefusal[] = [];
  if (block.runtime === null && block.source === null) {
    out.push(
      refusal(
        `criterion ${block.criterion} carries a verdict and names nothing it was judged against — a verdict that keeps its claim and drops the moment cannot be told later from one taken against what is running`,
        `criterion: ${block.criterion}`,
      ),
    );
    return out;
  }
  for (const [key, value] of [
    [RUNTIME_FIELD, block.runtime],
    [SOURCE_FIELD, block.source],
  ] as const) {
    if (value === null) continue;
    if (!recognisableIdentity(value)) {
      out.push(
        refusal(
          `criterion ${block.criterion}'s \`${key}\` field holds \`${value}\`, which is not written as an identity: an identity is at least ${SHORTEST_ABBREVIATION} hexadecimal characters and nothing else`,
          `${key}: ${value}`,
        ),
      );
      continue;
    }
    if (key === RUNTIME_FIELD && !wholeIdentity(value)) {
      out.push(
        refusal(
          `criterion ${block.criterion}'s \`${RUNTIME_FIELD}\` field holds \`${value}\`, an abbreviation — a runtime is named in full, because an abbreviation of the identity an issue records as serving would let a verdict taken somewhere else read as standing`,
          `${RUNTIME_FIELD}: ${value}`,
        ),
      );
    }
  }
  return out;
}

/** Everything a `verdict` record is refused for about the identities its blocks name. */
export function verdictIdentityRefusals(record: ForgeRecord | null): MessageRefusal[] {
  const out: MessageRefusal[] = [];
  for (const block of criterionBlocksIn(record)) {
    if (block.verdict === null) continue;
    out.push(...refusalsForBlock(block));
  }
  return out;
}
