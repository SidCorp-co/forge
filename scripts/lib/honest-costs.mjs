import { readdirSync } from 'node:fs';
import { withoutComments, withoutFences } from './markdown.mjs';

export const SECTION_RE = /^(#{2,6})\s+(?:\d+\.\s*)?honest costs\b.*$/im;

/** The index at any depth carries the rule, not a price of its own. */
const INDEX = 'README.md';

export function selectProposals(entries) {
  return entries.filter((n) => n.endsWith('.md') && n.split('/').pop() !== INDEX);
}

export function listProposals(dir) {
  const entries = readdirSync(dir, { recursive: true }).map((n) => String(n).split('\\').join('/'));
  return selectProposals(entries);
}

/** A section that is present and says nothing is the shape this gate exists to refuse. */
const MIN_WORDS = 12;

const PLACEHOLDER_RE = /^(tbd|todo|t\.b\.d\.?|n\/a|none|nothing|unknown|\?+)\.?$/i;

const ROW_RE = /^\s*(\||[-*+]\s|\d+\.\s)/;

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
    .filter((c) => c && !/^:?-{2,}:?$/.test(c));
}

/**
 * Returns the reasons `rel` fails the rule, one string each. Empty means it passes.
 */
export function judgeDocument(rel, raw) {
  const text = withoutComments(withoutFences(raw));
  const match = SECTION_RE.exec(text);
  if (!match) {
    return [`${rel}: no \`## Honest costs\` section — nothing here says what choosing this costs`];
  }
  const body = sectionBody(text, match);
  const words = body.flatMap(cells).join(' ').split(/\s+/).filter(Boolean).length;
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

/** A proposal names how it leaves: once the issue carrying it lands, the landing change deletes it. */
const REMOVED_WHEN_RE = /^\*\*Removed when:\*\*/;

const ISSUE_KEY_RE = /\b[A-Z][A-Z0-9]+-\d+\b/;

/** A file directly under `docs/proposals/`; `destination/` describes where the tree is going and never lands. */
export function isProposal(rel) {
  return /^docs\/proposals\/[^/]+\.md$/.test(rel) && !rel.endsWith(`/${INDEX}`);
}

/** The first paragraph after the title, which is where the reader looks for when the file goes. */
function openingParagraph(text) {
  const lines = text.split('\n');
  let i = lines.findIndex((l) => /^#\s/.test(l));
  i = i < 0 ? 0 : i + 1;
  while (i < lines.length && lines[i].trim() === '') i += 1;
  const para = [];
  while (i < lines.length && lines[i].trim() !== '') para.push(lines[i++]);
  return para.join(' ');
}

/**
 * Returns the reasons `rel` does not say when it is removed, one string each. Empty means it passes.
 */
export function judgeRemoval(rel, raw) {
  const opening = openingParagraph(withoutComments(withoutFences(raw)));
  if (!REMOVED_WHEN_RE.test(opening)) {
    return [
      `${rel}: does not open with a \`**Removed when:**\` line — nothing says when this proposal leaves the docs`,
    ];
  }
  if (!ISSUE_KEY_RE.test(opening)) {
    return [
      `${rel}: the \`**Removed when:**\` line names no issue key — a condition no issue carries is never landed, so the file is never deleted`,
    ];
  }
  return [];
}

/**
 * `documents` maps repo-relative path -> file text.
 *
 * Returns `{ code: 0, scanned }`, `{ code: 1, scanned, violations }`, or
 * `{ code: 2, reason }`.
 */
export function judge(documents) {
  const paths = Object.keys(documents);
  if (paths.length === 0) {
    return { code: 2, reason: 'no documents in scope — the rule would hold over nothing' };
  }
  const unreadable = paths.filter((p) => typeof documents[p] !== 'string');
  if (unreadable.length > 0) {
    return { code: 2, reason: `could not read ${unreadable.join(', ')}` };
  }
  const violations = paths.flatMap((p) => [
    ...judgeDocument(p, documents[p]),
    ...(isProposal(p) ? judgeRemoval(p, documents[p]) : []),
  ]);
  return violations.length > 0
    ? { code: 1, scanned: paths.length, violations }
    : { code: 0, scanned: paths.length };
}
