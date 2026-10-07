// What a turn posts when it runs past its first ceiling and keeps working: the calls that landed,
// writes first with the keys they returned, then what it read, and that the rest follows in this
// thread. Code writes it from the turn's own ledger, so it states nothing the turn did not do.

import { partialReplyWords, type ReplyLanguage } from '../conversations/index.js';
import type { DoneCall } from './turn-writes.js';

/** How many reads are named by their call; the rest are counted. */
const NAMED_READS = 5;
const NAMED_WRITES = 10;

const writeLine = (c: DoneCall): string =>
  c.keys.length > 0 ? `- ${c.said} → ${c.keys.join(', ')}` : `- ${c.said} → ${c.result}`;

export function partialReplyText(args: {
  calls: readonly DoneCall[];
  language: ReplyLanguage;
  handleName: string;
  waitedMs: number;
}): string {
  const words = partialReplyWords(args.language);
  const lines = [words.head(args.handleName, Math.round(args.waitedMs / 1000))];
  const writes = args.calls.filter((c) => c.write);
  const reads = args.calls.filter((c) => !c.write);
  if (writes.length === 0 && reads.length === 0) return [...lines, '', words.nothingYet].join('\n');
  if (writes.length > 0) {
    lines.push('', words.did, ...writes.slice(-NAMED_WRITES).map(writeLine));
  }
  if (reads.length > 0) {
    lines.push(
      '',
      words.read(reads.length),
      ...reads.slice(-NAMED_READS).map((c) => `- ${c.said}`),
    );
  }
  return lines.join('\n');
}
