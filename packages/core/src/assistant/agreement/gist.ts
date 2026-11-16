// The proposal's own one-line summary, which a card shows beside "No summary" where the proposing
// agent wrote no plain line (ISS-1006, the live judge on 0.4.0-dev.696: two "Revision of REQ-68"
// cards read "No summary" and two buttons, and nothing on them said what Record it would record).
// A requirement's draft or revision carries its own: its `tldr`, else its `changeSummary`. It is read
// from the held call at every view, so a card held before this was written reads it too. Keys are
// stripped, since no key carries meaning where a person decides.

import type { ChatProposalKind } from '@forge/contracts/chat-proposals';
import type { HeldRestCall, HeldToolCall } from './store.js';

/** The most a gist line shows: one line, never the whole proposal. */
const GIST_MAX = 300;

const KEYS = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g;

const GIST_KINDS: ReadonlySet<ChatProposalKind> = new Set([
  'requirement_draft',
  'requirement_revision',
]);

type Args = Record<string, unknown>;

function objectOf(json: string): Args {
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Args) : {};
  } catch {
    return {};
  }
}

/** What the held call writes: a tool call's arguments, or a REST request's JSON body. */
function argsOf(call: HeldToolCall | HeldRestCall, body: Buffer | null): Args {
  if ('arguments' in call) return objectOf(call.arguments);
  if (!body || !/json/i.test(call.contentType ?? '')) return {};
  return objectOf(body.toString('utf8'));
}

/** A text as one line with no key in it: what is left reads as words, or null where nothing is. */
export function keylessLine(text: string): string | null {
  const line = text
    .replace(KEYS, '')
    .replace(/\(\s*[,;]?\s*\)/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:)])/g, '$1')
    .replace(/\(\s+/g, '(')
    .trim();
  if (!/[\p{L}\p{N}]/u.test(line)) return null;
  if (line.length <= GIST_MAX) return line;
  const cut = line.slice(0, GIST_MAX);
  const atWord = cut.lastIndexOf(' ');
  return `${(atWord > GIST_MAX / 2 ? cut.slice(0, atWord) : cut).trimEnd()}…`;
}

/** The proposal's own summary line, its `tldr` else its `changeSummary`; null where it has neither. */
export function gistOf(row: {
  kind: ChatProposalKind;
  call: unknown;
  body: Buffer | null;
}): string | null {
  if (!GIST_KINDS.has(row.kind)) return null;
  const args = argsOf(row.call as HeldToolCall | HeldRestCall, row.body);
  for (const field of ['tldr', 'changeSummary']) {
    const v = args[field];
    const line = typeof v === 'string' ? keylessLine(v) : null;
    if (line) return line;
  }
  return null;
}
