/**
 * ISS-1056 — the weekly report as a function over plain objects: the week's history result, the
 * previous week's (or none), the harvest, and the window. Returns the comment body and the files
 * to attach; writes nothing and asks no model. The first line is the week's identity — the
 * already-posted check reads it — and says thin under `THIN_ROWS`.
 */

import type { Candidate, Skipped } from '../harvest.js';
import { agreementLine, tally, tallyLine } from '../judge.js';
import { compareHistory, compareHistoryLines } from './compare.js';
import type { HistoryResult } from './result.js';
import { THIN_ROWS } from './summarize.js';

export interface ReportFile {
  name: string;
  // cm:why text/plain for the JSON too: the comment door's allowed set (`lib/attachment-mime.ts`, comment target) carries no application/json, and text bytes under a declared text/plain pass whatever the extension; the `.json` name is what `weekly/previous.ts` matches on
  mime: 'text/plain';
  text: string;
}

export interface WeeklyReport {
  /** The comment body, Markdown. */
  body: string;
  files: ReportFile[];
}

export interface WeeklyReportInput {
  windowId: string;
  result: HistoryResult;
  previous: HistoryResult | null;
  harvest: { candidates: Candidate[]; skipped: Skipped[] };
}

/** The head every report's first line starts with; a failure comment's line differs after the id. */
export const reportHead = (windowId: string): string => `Assistant weekly reading ${windowId}:`;

/** The whole first line: the window, the rows, and thin under THIN_ROWS. */
export function reportFirstLine(windowId: string, rows: number): string {
  const thin = rows < THIN_ROWS ? ` — thin (under ${THIN_ROWS})` : '';
  return `${reportHead(windowId)} ${rows} rows${thin}`;
}

/** The one line a failed week posts instead of a report. */
export const failureLine = (windowId: string, err: { name: string; message: string }): string =>
  `Assistant weekly reading ${windowId} failed: ${err.name}: ${err.message}`;

const pct = (rate: number | null): string =>
  rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`;

function groupLines(result: HistoryResult): string[] {
  if (result.groups.length === 0) return ['no rows in the window'];
  const lines: string[] = [];
  for (const g of result.groups) {
    lines.push(
      `- **${g.model} / ${g.source}**: ${g.rows} rows, ${g.sessions} sessions${g.thin ? ' (thin)' : ''}`,
    );
    const modes = Object.entries(g.modes)
      .filter(([, t]) => t.count > 0)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([m, t]) => `${m} ${t.count}/${g.rows} (${pct(t.rate)})`);
    lines.push(`  - ${modes.length > 0 ? modes.join(', ') : 'no mode over the rows'}`);
  }
  return lines;
}

function judgeLines(result: HistoryResult): string[] {
  const j = result.judge;
  if (!j) return ['no judge ran'];
  return [
    `judge ${j.model}, ${j.rows.length} of ${j.sample} asked: ${tallyLine(tally(j.rows.map((r) => r.judge)))}`,
    agreementLine(j.agreement),
  ];
}

const rowCount = (r: HistoryResult): number => r.groups.reduce((n, g) => n + g.rows, 0);

/** The comment and its files for one week. */
export function weeklyReport(input: WeeklyReportInput): WeeklyReport {
  const { windowId, result, previous, harvest } = input;
  const rows = rowCount(result);
  const body: string[] = [reportFirstLine(windowId, rows), ''];
  body.push(
    `Read from the deployment at ${result.commit ?? 'an unnamed commit'} (${result.version}); ${result.excludedRows} row(s) of ${result.excludedSessions.length} bench room(s) excluded; links ${result.resolved ? 'resolved' : 'not resolved'}.`,
    '',
    '## Per model and door',
    ...groupLines(result),
    '',
    '## Judge',
    ...judgeLines(result),
    '',
  );
  const files: ReportFile[] = [
    {
      name: `assistant-history-${windowId}.json`,
      mime: 'text/plain',
      text: `${JSON.stringify(result, null, 2)}\n`,
    },
  ];
  if (previous) {
    const lines = compareHistoryLines(compareHistory(previous, result));
    body.push(
      `## What changed since ${previous.window.from}..${previous.window.to}`,
      '```',
      ...lines,
      '```',
      '',
    );
    files.push({
      name: `assistant-compare-${windowId}.txt`,
      mime: 'text/plain',
      text: `${lines.join('\n')}\n`,
    });
  } else {
    body.push(
      '## What changed',
      "no previous week's file on this issue; the comparison starts next week",
      '',
    );
  }
  body.push("## Candidates from the judge's no and partial");
  if (harvest.candidates.length === 0) {
    const reasons = [...new Set(harvest.skipped.map((s) => s.reason.replace(/ \(\d+%\)$/, '')))];
    body.push(
      `none: every no/partial row is covered by a shipped task or skipped${reasons.length > 0 ? ` (${reasons.join('; ')})` : ''}`,
    );
  } else {
    for (const c of harvest.candidates) {
      const served = result.judge?.rows.find((r) => r.chatLogId === c.chatLogId)?.judge;
      const verdict = served && 'served' in served ? served.served : 'unreadable';
      body.push(`- ${c.intent} — chat_logs ${c.chatLogId} — ${verdict}`);
      files.push({ name: `candidate-${c.id}.ts.txt`, mime: 'text/plain', text: c.source });
    }
  }
  body.push(
    '',
    `The files behind this report are attached; the next week's reading compares against \`assistant-history-${windowId}.json\`.`,
  );
  return { body: body.join('\n'), files };
}
