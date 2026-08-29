// The verdict half of check-honest-costs, kept apart from the CLI so it can be
// tested. The CLI spawns nothing but does exit at module scope; everything a
// test needs to drive — which files are in scope, and whether one of them
// prices anything — lives here.
//
// What it can see: whether a document carries a section that prices what
// choosing it costs, and whether that section says anything. What it CANNOT
// see: whether the price stated there is honest. That half belongs to review
// and to whoever writes the doc — a checker asserting it would be reading
// prose for sincerity, which is the kind of claim this repo refuses to make.

import { readdirSync } from 'node:fs';

// cm:edge contract -> docs/proposals/README.md — that file publishes this heading to whoever writes the next proposal; the two are agreed by nothing a compiler checks, so a reword here with none there leaves authors following a rule the gate no longer enforces
export const SECTION_RE = /^(#{2,6})\s*(?:\d+\.\s*)?honest costs\b.*$/im;

/** The index at any depth carries the rule, not a price of its own. */
const INDEX = 'README.md';

// cm:guard filter by BASENAME over a RECURSIVE listing. A flat read, or a whole-path compare against `README.md`, both narrow the enforced scope below the one `docs/proposals/README.md` publishes ("every `.md` here") — and a document the gate never opens is one it reports as priced, because the success line counts what it scanned rather than what exists.
export function selectProposals(entries) {
  return entries.filter((n) => n.endsWith('.md') && n.split('/').pop() !== INDEX);
}

// cm:guard the `recursive` flag belongs HERE, with the filter it is half of. It sat in the CLI for one round, where the only thing that could test it was a hand-built copy of the tree — and a filter tested over a synthetic list stays green when the listing that feeds it goes flat, which is the under-scope re-opening with every test still passing.
export function listProposals(dir) {
  const entries = readdirSync(dir, { recursive: true }).map((n) => String(n).split('\\').join('/'));
  return selectProposals(entries);
}

/** A section that is present and says nothing is the shape this gate exists to refuse. */
const MIN_WORDS = 12;

// cm:guard the token must be the WHOLE cell or bullet, never a substring. `N/A` matched anywhere flags a row that legitimately says "N/A for self-hosted", and a rule that fires on the honest answer is how an exemption gets written for it.
const PLACEHOLDER_RE = /^(tbd|todo|t\.b\.d\.?|n\/a|none|nothing|unknown|\?+)\.?$/i;

const ROW_RE = /^\s*(\||[-*+]\s|\d+\.\s)/;

// cm:guard a fenced block is not content. `## Honest costs` inside a ```md example satisfied the heading match while the document itself priced nothing — the published rule refuses an absent section, and a section that exists only as an illustration of the rule is absent.
function withoutFences(text) {
  let fenced = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return '';
      }
      return fenced ? '' : line;
    })
    .join('\n');
}

function headingLevel(line) {
  return /^(#{1,6})\s/.exec(line)?.[1].length ?? 0;
}

/** The lines under the heading, up to the next heading at the same level or higher. */
function sectionBody(text, match) {
  const level = match[1].length;
  const after = text
    .slice(match.index + match[0].length)
    .split('\n')
    .slice(1);
  const end = after.findIndex((l) => {
    const h = headingLevel(l);
    return h > 0 && h <= level;
  });
  return (end < 0 ? after : after.slice(0, end)).filter((l) => l.trim() !== '');
}

function cells(line) {
  return line
    .replace(ROW_RE, '')
    .split('|')
    .map((c) => c.replace(/[*_`]/g, '').trim())
    .filter(Boolean);
}

/**
 * Returns the reasons `rel` fails the rule, one string each. Empty means it passes.
 */
export function judgeDocument(rel, raw) {
  const text = withoutFences(raw);
  const match = SECTION_RE.exec(text);
  if (!match) {
    return [`${rel}: no \`## Honest costs\` section — nothing here says what choosing this costs`];
  }
  const body = sectionBody(text, match);
  const words = body.join(' ').split(/\s+/).filter(Boolean).length;
  const reasons = [];
  if (words < MIN_WORDS) {
    reasons.push(
      `${rel}: the Honest costs section holds ${words} word(s) — present, and it prices nothing`,
    );
  }
  if (!body.some((l) => ROW_RE.test(l))) {
    reasons.push(
      `${rel}: the Honest costs section is prose — price it as a table or a list, one cost per row`,
    );
  }
  const placeholders = body.flatMap(cells).filter((c) => PLACEHOLDER_RE.test(c));
  if (placeholders.length > 0) {
    reasons.push(
      `${rel}: the Honest costs section answers \`${placeholders[0]}\` — a cost nobody has worked out is not a priced trade-off`,
    );
  }
  return reasons;
}

/**
 * `documents` maps repo-relative path -> file text.
 *
 * Returns `{ code: 0, scanned }`, `{ code: 1, scanned, violations }`, or
 * `{ code: 2, reason }`.
 */
// cm:guard an empty scope is exit 2, never a pass. This gate's whole subject is documents that ought to exist, so "I found no proposals" and "every proposal prices itself" must never print the same verdict — a renamed directory would otherwise turn the rule off silently.
export function judge(documents) {
  const paths = Object.keys(documents);
  if (paths.length === 0) {
    return { code: 2, reason: 'no documents in scope — the rule would hold over nothing' };
  }
  const unreadable = paths.filter((p) => typeof documents[p] !== 'string');
  if (unreadable.length > 0) {
    return { code: 2, reason: `could not read ${unreadable.join(', ')}` };
  }
  const violations = paths.flatMap((p) => judgeDocument(p, documents[p]));
  return violations.length > 0
    ? { code: 1, scanned: paths.length, violations }
    : { code: 0, scanned: paths.length };
}
