/**
 * ISS-1055 — a judged history file read into candidate benchmark tasks: one module per row the
 * judge called `no` or `partial` whose intent no shipped task covers, in the benchmark's own
 * `Task` shape with the person's real query as the message and the expectations left empty, so
 * `validateTasks` refuses the candidate until a person writes them. Reads a file, writes files,
 * asks no model and never reaches the deployment. Every text the module carries is scrubbed
 * first — the query, and the judge's intent and reason, which repeat what the person wrote.
 */

import { CORRECTIVE_PREFIX } from '../../conversations/fallback-replies.js';
import type { HistoryResult, JudgedRow } from './history/result.js';
import { isVerdict } from './judge.js';
import type { Task } from './task.js';

/** A row is covered when this share of its intent's content words appears in one task's text. */
export const COVERED_SHARE = 0.6;
/** A query with fewer words than this is not a task anyone can grade. */
export const MIN_QUERY_WORDS = 3;

/** Function words that say nothing about what a person wanted. */
export const STOPWORDS: ReadonlySet<string> = new Set([
  'about',
  'after',
  'again',
  'also',
  'anything',
  'because',
  'been',
  'before',
  'being',
  'both',
  'could',
  'does',
  'doing',
  'each',
  'else',
  'every',
  'from',
  'have',
  'having',
  'here',
  'into',
  'just',
  'like',
  'more',
  'most',
  'much',
  'must',
  'only',
  'other',
  'over',
  'person',
  'please',
  'same',
  'should',
  'since',
  'some',
  'such',
  'than',
  'that',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'under',
  'until',
  'very',
  'want',
  'wanted',
  'wants',
  'were',
  'what',
  'when',
  'where',
  'whether',
  'which',
  'while',
  'will',
  'with',
  'would',
  'your',
]);

/** The lowercase letters-only words of four or more letters, minus the stopwords, each once. */
export function contentWords(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  return [...new Set(words)].filter((w) => !STOPWORDS.has(w));
}

/** The task whose intent and id hold the largest share of the intent's content words. */
export function coverage(
  intent: string,
  tasks: readonly Task[],
): { task: string; share: number } | null {
  const words = contentWords(intent);
  if (words.length === 0) return null;
  let best: { task: string; share: number } | null = null;
  for (const task of tasks) {
    const own = new Set(contentWords(`${task.id.replace(/-/g, ' ')} ${task.intent}`));
    const share = words.filter((w) => own.has(w)).length / words.length;
    if (best === null || share > best.share) best = { task: task.id, share };
  }
  return best;
}

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const URL_HOST_RE = /(https?:\/\/)[^\s/]+/gi;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HANDLE_RE = /(^|[^\w])@[\w.-]+/g;
const ISSUE_KEY_RE = /\b[A-Z]{2,6}-\d+\b/g;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The text with what could name a person or a row replaced by a typed placeholder. A name is
 * what the row knows the asker as and any handle; nothing is guessed from capitalisation.
 */
export function scrubQuery(text: string, opts: { askedBy: string | null }): string {
  let out = text
    .replace(EMAIL_RE, '<email>')
    .replace(URL_HOST_RE, '$1<host>')
    .replace(UUID_RE, '<uuid>')
    .replace(HANDLE_RE, '$1<person>')
    .replace(ISSUE_KEY_RE, 'ISS-<n>');
  const name = opts.askedBy?.trim();
  if (name) out = out.replace(new RegExp(`(?<![\\w])${escapeRe(name)}(?![\\w])`, 'gi'), '<person>');
  return out;
}

export interface Candidate {
  id: string;
  file: string;
  intent: string;
  chatLogId: string;
  source: string;
}

export interface Skipped {
  chatLogId: string;
  reason: string;
}

export class HarvestRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarvestRefusal';
  }
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

const camel = (id: string): string =>
  id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase()).replace(/^[0-9]/, (c) => `n${c}`);

function candidateId(intent: string, chatLogId: string): string {
  const words = contentWords(intent).slice(0, 5);
  const head = words.length > 0 ? words.join('-') : 'candidate';
  return `${head}-${chatLogId.replace(/-/g, '').slice(0, 8).toLowerCase()}`;
}

/** The module a person moves into `tasks/` once the checks are written. */
function candidateSource(
  row: JudgedRow,
  judgeModel: string,
  served: string,
  texts: { query: string; intent: string; reason: string },
  id: string,
): string {
  return [
    `// Harvested by bench:assistant harvest (ISS-1055) from a judged history row.`,
    `// chat_logs id: ${row.chatLogId}`,
    `// room (session_id): ${row.sessionId ?? 'none'}`,
    `// created at: ${row.createdAt}`,
    `// judge ${judgeModel} said ${served}: ${oneLine(texts.reason)}`,
    `import type { Task } from '../task.js';`,
    ``,
    `/** The expectations are a person's to write: \`validateTasks\` refuses the empty checks list until then. */`,
    `export const ${camel(id)}: Task = {`,
    `  id: ${JSON.stringify(id)},`,
    `  // a harvested exchange measures the method until a person reads it as one of the other capabilities`,
    `  capability: 'method',`,
    `  intent: ${JSON.stringify(oneLine(texts.intent))},`,
    `  budgetSeconds: 90,`,
    `  turns: [{ message: ${JSON.stringify(texts.query)}, checks: [] }],`,
    `};`,
    ``,
  ].join('\n');
}

/** Every candidate the file's judged rows give, and every row skipped with its reason. */
export function harvest(
  result: HistoryResult,
  tasks: readonly Task[],
  file = 'history',
): { candidates: Candidate[]; skipped: Skipped[] } {
  const judge = result.judge;
  if (!judge)
    throw new HarvestRefusal(`${file} carries no judge; run history --judge on the window first`);
  const candidates: Candidate[] = [];
  const skipped: Skipped[] = [];
  for (const row of judge.rows) {
    if (row.query === undefined)
      throw new HarvestRefusal(
        `${file} was judged before ISS-1055 and its rows carry no query; run history --judge on the window again`,
      );
    if (!isVerdict(row.judge)) {
      skipped.push({ chatLogId: row.chatLogId, reason: 'unreadable verdict' });
      continue;
    }
    if (row.judge.served === 'yes') {
      skipped.push({ chatLogId: row.chatLogId, reason: 'judged yes' });
      continue;
    }
    if (row.query.trim().split(/\s+/).filter(Boolean).length < MIN_QUERY_WORDS) {
      skipped.push({ chatLogId: row.chatLogId, reason: 'query too short' });
      continue;
    }
    if (row.query.trimStart().startsWith(CORRECTIVE_PREFIX)) {
      skipped.push({ chatLogId: row.chatLogId, reason: "retry row, not a person's query" });
      continue;
    }
    const scrub = { askedBy: row.askedBy ?? null };
    const intent = scrubQuery(row.judge.intent, scrub);
    const covered = coverage(intent, tasks);
    if (covered && covered.share >= COVERED_SHARE) {
      skipped.push({
        chatLogId: row.chatLogId,
        reason: `intent covered by ${covered.task} (${Math.round(covered.share * 100)}%)`,
      });
      continue;
    }
    const id = candidateId(intent, row.chatLogId);
    candidates.push({
      id,
      file: `${id}.ts`,
      intent: oneLine(intent),
      chatLogId: row.chatLogId,
      source: candidateSource(
        row,
        judge.model,
        row.judge.served,
        {
          query: scrubQuery(row.query, scrub),
          intent,
          reason: scrubQuery(row.judge.reason, scrub),
        },
        id,
      ),
    });
  }
  return { candidates, skipped };
}

/** What was written and what was skipped, for the terminal. */
export function harvestLines(
  out: { candidates: Candidate[]; skipped: Skipped[] },
  dir: string,
): string[] {
  const lines = [`wrote ${out.candidates.length} candidate(s) to ${dir}`];
  for (const c of out.candidates) lines.push(`  ${c.file} — ${c.intent}`);
  lines.push(`skipped ${out.skipped.length}:`);
  for (const s of out.skipped) lines.push(`  ${s.chatLogId.slice(0, 8)} — ${s.reason}`);
  return lines;
}
