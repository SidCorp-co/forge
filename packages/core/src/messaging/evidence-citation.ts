/**
 * What a verdict block cites, and what the write door refuses a citation for. A citation naming a
 * path on the machine that wrote it can never resolve for anyone else, so it is refused here,
 * where whoever wrote it is still there to attach the file instead.
 */

import type { MessageRefusal } from './contract.js';
import type { ForgeRecord } from './forge-record.js';
import { type CriterionBlock, criterionBlocksIn, EVIDENCE_FIELD } from './verdict-identity.js';

export type CitationForm = 'url' | 'machine-path' | 'identity' | 'in-tree' | 'attachment';

/** The verdicts taken by looking, which owe what they were taken from. `skipped` owes nothing. */
export const EXERCISED_VERDICTS: ReadonlySet<string> = new Set(['pass', 'fail', 'short']);

const URL = /^https?:\/\//iu;
const MACHINE_PATH = /^(?:\/|~\/|file:\/\/)/u;
const IDENTITY = /^[0-9a-f]{7,40}$/iu;
const IN_TREE = /^[\w.@-]+(?:\/[\w.@-]+)+$/u;

const RULE = 'verdict-evidence';

const SHAPE =
  'a criterion block whose verdict was taken by looking cites what it was taken from, as `evidence: <the name of a file attached to this issue>`, a URL, or an object id — never a path on the machine that wrote it';

const EXAMPLE = [
  '```forge-record: verdict · contract 1',
  'criterion: 13',
  'verdict: pass',
  'runtime: 33637c612ef15be6f924520c0d201a0889d8ed7e',
  'evidence: iss-1198-judge-log.txt',
  '```',
].join('\n');

/**
 * The first four forms are disjoint and are tried in order; `attachment` takes what they leave.
 * The order decides their one overlap: seven to forty hexadecimal characters would also be a legal
 * file name, and is read as an object id because that is what a writer means by it.
 */
export function citationForm(cited: string): CitationForm {
  const value = cited.trim();
  if (URL.test(value)) return 'url';
  if (MACHINE_PATH.test(value)) return 'machine-path';
  if (IDENTITY.test(value)) return 'identity';
  if (IN_TREE.test(value)) return 'in-tree';
  return 'attachment';
}

function refusal(why: string, quote: string): MessageRefusal {
  return { rule: RULE, why, quote, shape: SHAPE, example: EXAMPLE };
}

function citesNothing(block: CriterionBlock): MessageRefusal | null {
  if (block.verdict === null || !EXERCISED_VERDICTS.has(block.verdict)) return null;
  if (block.cited.length > 0) return null;
  return refusal(
    `criterion ${block.criterion} records \`${block.verdict}\` and cites nothing it was taken from — a verdict taken by looking names what was looked at, and one citing nothing cannot be told afterwards from one whose evidence was lost before it was written`,
    `verdict: ${block.verdict}`,
  );
}

function refusalsForBlock(block: CriterionBlock): MessageRefusal[] {
  const out: MessageRefusal[] = [];
  const nothing = citesNothing(block);
  if (nothing) out.push(nothing);
  for (const cited of block.cited) {
    if (citationForm(cited) !== 'machine-path') continue;
    out.push(
      refusal(
        `criterion ${block.criterion} cites \`${cited}\`, a path on the machine that wrote this record — the tracker holds no bytes for a path, so nobody reading this issue can follow it. Attach the file and cite it by its name`,
        `${EVIDENCE_FIELD}: ${cited}`,
      ),
    );
  }
  return out;
}

/** Everything a `verdict` record is refused for about the evidence its blocks cite. */
export function verdictEvidenceRefusals(record: ForgeRecord | null): MessageRefusal[] {
  const out: MessageRefusal[] = [];
  for (const block of criterionBlocksIn(record)) out.push(...refusalsForBlock(block));
  return out;
}
