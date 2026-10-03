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
/** The field a criterion block names the stored workflow design revision it was judged against:
 *  the identity of work that lands as a design rather than as commits (an issue outside git). */
export const DESIGN_FIELD = 'design';
/** The field a criterion block names the contract version it was judged against:
 *  `<project slug>/<contract slug>@<version>`, a version the issue's project recorded. */
export const CONTRACT_FIELD = 'contract';

/** The field a criterion block cites what its verdict was taken from in. */
export const EVIDENCE_FIELD = 'evidence';

/** Seven is the shortest abbreviation git mints; forty is a whole object id. */
export const SHORTEST_ABBREVIATION = 7;
export const SHORTEST_WHOLE_IDENTITY = 40;

const HEXADECIMAL = /^[0-9a-f]+$/iu;

const RULE = 'verdict-identity';

const SHAPE =
  "a criterion block of a `verdict` record names what it was judged against: `runtime: <a whole object id>` for an identity something was observed serving, `commit: <at least seven hex characters>` for a source that was read, `design: <workflow flow or id> rev <n>` for a workflow design revision this issue's project holds, or `contract: <project>/<contract>@<version>` for a contract version this issue's project recorded";

/** `<workflow flow or id> rev <n>`: the flow slug or the workflow's id, then its revision. */
const DESIGN_SHAPE = /^(\S+)\s+rev\s+(\d+)$/u;

export interface DesignIdentity {
  /** The workflow's flow slug or its id, as written. */
  readonly workflow: string;
  readonly revision: number;
}

/** The design a `design:` value names, or null where it is not written as `<flow or id> rev <n>`. */
export function parseDesignIdentity(value: string | null | undefined): DesignIdentity | null {
  const match = DESIGN_SHAPE.exec(String(value ?? '').trim());
  if (!match) return null;
  const revision = Number.parseInt(match[2] as string, 10);
  if (!Number.isSafeInteger(revision) || revision < 1) return null;
  return { workflow: match[1] as string, revision };
}

/** `<project slug>/<contract slug>@<version>`: the reference the interface names a contract by, then a version. */
const CONTRACT_SHAPE = /^([a-z][a-z0-9-]{0,62})\/([a-z][a-z0-9-]{0,62})@(\S{1,40})$/u;

export interface ContractIdentity {
  readonly project: string;
  readonly contract: string;
  readonly version: string;
}

/** The contract version a `contract:` value names, or null where it is not `<project>/<contract>@<version>`. */
export function parseContractIdentity(value: string | null | undefined): ContractIdentity | null {
  const match = CONTRACT_SHAPE.exec(String(value ?? '').trim());
  if (!match) return null;
  return {
    project: match[1] as string,
    contract: match[2] as string,
    version: match[3] as string,
  };
}

const EXAMPLE = [
  '```forge-record: verdict · contract 1',
  'criterion: 13',
  'verdict: pass',
  'runtime: 33637c612ef15be6f924520c0d201a0889d8ed7e',
  'evidence: iss-1198-judge-log.txt',
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

/** The longest spelling of `value`'s identity among `values`; one two identities extend is left
 *  as written, since naming either would be a guess (ISS-1346). */
export function longestSpelling(values: readonly string[]): (value: string) => string {
  return (value) => {
    const longer = values.filter(
      (other) =>
        other.trim().length > value.trim().length &&
        sameIdentity(value, other, { abbreviating: true }),
    );
    const longest = longer.reduce((a, b) => (b.trim().length > a.trim().length ? b : a), value);
    return longer.every((other) => sameIdentity(other, longest, { abbreviating: true }))
      ? longest
      : value;
  };
}

export interface CriterionBlock {
  readonly criterion: number;
  readonly verdict: string | null;
  readonly runtime: string | null;
  readonly source: string | null;
  readonly design: string | null;
  /** The block's `why` line: the reason a `skipped` verdict must carry (ISS-55). */
  readonly why: string | null;
  readonly contract: string | null;
  /** Everything this block cites, in the order written. An empty value cites nothing. */
  readonly cited: readonly string[];
}

interface OpenBlock {
  criterion: number;
  verdict: string | null;
  runtime: string | null;
  source: string | null;
  design: string | null;
  why: string | null;
  contract: string | null;
  cited: string[];
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
        block = {
          criterion: n,
          verdict: null,
          runtime: null,
          source: null,
          design: null,
          why: null,
          contract: null,
          cited: [],
        };
      }
      continue;
    }
    if (!block) continue;
    if (field.key === 'verdict' && block.verdict === null) block.verdict = value;
    else if (field.key === RUNTIME_FIELD && block.runtime === null) block.runtime = value;
    else if (field.key === SOURCE_FIELD && block.source === null) block.source = value;
    else if (field.key === DESIGN_FIELD && block.design === null) block.design = value;
    else if (field.key === 'why' && block.why === null && value !== '') block.why = value;
    else if (field.key === CONTRACT_FIELD && block.contract === null) block.contract = value;
    else if (field.key === EVIDENCE_FIELD && value !== '') block.cited.push(value);
  }
  close();
  return out;
}

function refusal(why: string, quote: string): MessageRefusal {
  return { rule: RULE, why, quote, shape: SHAPE, example: EXAMPLE };
}

function refusalsForBlock(block: CriterionBlock): MessageRefusal[] {
  const out: MessageRefusal[] = [];
  if (
    block.runtime === null &&
    block.source === null &&
    block.design === null &&
    block.contract === null
  ) {
    out.push(
      refusal(
        `criterion ${block.criterion} carries a verdict and names nothing it was judged against — a verdict that keeps its claim and drops the moment cannot be told later from one taken against what is running`,
        `criterion: ${block.criterion}`,
      ),
    );
    return out;
  }
  if (block.design !== null && parseDesignIdentity(block.design) === null) {
    out.push(
      refusal(
        `criterion ${block.criterion}'s \`${DESIGN_FIELD}\` field holds \`${block.design}\`, which is not written as a design identity: it is the workflow's flow or id, the word \`rev\`, and a revision number of 1 or more`,
        `${DESIGN_FIELD}: ${block.design}`,
      ),
    );
  }
  if (block.contract !== null && parseContractIdentity(block.contract) === null) {
    out.push(
      refusal(
        `criterion ${block.criterion}'s \`${CONTRACT_FIELD}\` field holds \`${block.contract}\`, which is not written as a contract identity: it is \`<project slug>/<contract slug>@<version>\`, the reference the interface names the contract by and a version recorded for it`,
        `${CONTRACT_FIELD}: ${block.contract}`,
      ),
    );
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
