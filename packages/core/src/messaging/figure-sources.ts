/**
 * The reads a figure can come from, and the rule that a figure names the one it came from (REQ-30
 * BC-1: "names the source of every figure it states"; chat-turn design, step `check`,
 * figures-name-source).
 *
 * `figures-rule.ts` holds a figure to a read of this turn. This file asks the reply to say which:
 * a figure some read holds, stated with no passage of the reply naming any read that holds it, is
 * held. A passage names a read when it is the figure's paragraph, the paragraph that introduces it
 * (it ends with a colon), the nearest heading above it, or a `Sources:` line and the list under it.
 *
 * A memory is the one read named by a date, not a word: a figure taken from it stands only as "a
 * memory of <the date it speaks as of> records …" (MJ-5, as `status-claims-rule.ts` asks of a
 * decision taken from memory). Stated any other way it reads as how things stand now, and is held.
 */

// every Vietnamese regex below carries its `i18n-allow` pragma on its own line: the language gate reads it same-line only.

import type { ReportFrame } from '@forge/contracts/report-queries';
import type { MessageRule, RuleBreak } from './contract.js';
import type { FigureFacts, FigureSource, ToolResultEntry } from './facts.js';
import { askersOwn, type StatedFigure, statedFigures } from './figure-exemptions.js';
import { atDecimals, frameValues, holds, valuesOfResult } from './figure-values.js';
import { blankMarkedClauses } from './reply-marks.js';
import { MEMORY_TOOL, memoryDatesRead, namesDateOf } from './status-claims-rule.js';

/** The source a turn's report runs make together. */
export const REPORT_SOURCE = 'report';

const REQ_KEY = /\bREQ-\d+\b/;
const VERSION = /\bv?\d+\.\d+\.\d+(?:-[\w.]+)?\b|\brelease\s+v?\d+\.\d+/i;

const REPORT_NAMES = [
  /\b(?:reports?|templates?|tables?|charts?|graphs?|boards?|blocks?|computations?|computed)\b/i,
  /báo\s+cáo|biểu\s+đồ|bảng/iu, // i18n-allow: the Vietnamese words for a report, a chart and a table
];
const STATUS_NAMES = [
  /\bproject(?:['’]s)?\s+status\b|\bstatus\s+(?:read|report|page|view|overview)\b|\bdashboard\b/i,
  /(?:trạng\s+thái|tình\s+trạng)\s+(?:của\s+)?dự\s+án/iu, // i18n-allow: the Vietnamese name of the project status
];
const REQUIREMENTS_NAMES = [
  REQ_KEY,
  /\brequirements?(?:['’]s?)?\s+(?:list|screen|page|read|register)\b/i,
  /danh\s+sách\s+yêu\s+cầu/iu, // i18n-allow: the Vietnamese name of the requirements list
];
const RELEASES_NAMES = [
  VERSION,
  /\breleases?\s+(?:list|screen|page|read|notes)\b/i,
  /danh\s+sách\s+(?:bản\s+)?phát\s+hành/iu, // i18n-allow: the Vietnamese name of the releases list
];
const METRICS_NAMES = [/\bmetrics?\b|\bstep\s+durations?\b|\btime[-\s]?series\b/i];
const DOCUMENT_NAMES = [
  /[\w-]+\.(?:md|txt|csv|json|pdf|docx)\b|\b(?:document|attachment|attached\s+file)\b/i,
  /tài\s+liệu|tệp\s+đính\s+kèm/iu, // i18n-allow: the Vietnamese words for a document and an attachment
];
const DECISION_NAMES = [
  /\bdecision(?:s|\s+log|\s+records?)?\b|\bdecided\b/i,
  /quyết\s+định/iu, // i18n-allow: the Vietnamese word for a decision
];

/**
 * The reads whose own result grounds a figure, the part of the result that does, and the names
 * that say a figure came from it: what code computed from the project's records, or
 * (`forge_requirement_draft`'s `preview` and `taken`) the count code took from a document the person
 * attached. The BA doors' record reads are the same kind: `ba_read_requirement` is
 * `forge_requirement` for the room's requirement, `ba_find_similar` answers code's similarity
 * scores, `ba_read_journeys` the designs onboarding drafted. `forge_decisions` answers the decision
 * records as written. `forge_memory` is a dated source (MJ-5): it is named only by its date.
 *
 * Absent on purpose: `forge_show`, `forge_feedback`, `forge_requirement_revise`, `forge_memory_note`
 * and `ba_suggest`, which answer with what the model sent them; `ba_read_issue`, an issue's free
 * text as someone wrote it, as `forge_issue` is; and `forge`, the CLI, whose verbs write as well as
 * read and whose output is no one shape.
 */
export const FIGURE_READS: readonly {
  readonly tool: string;
  readonly keys?: readonly string[];
  /** What naming this read looks like; absent for the memory, named by its date. */
  readonly names?: readonly RegExp[];
}[] = [
  { tool: 'forge_project_status', names: STATUS_NAMES },
  { tool: 'forge_requirements', names: REQUIREMENTS_NAMES },
  { tool: 'forge_requirement', names: REQUIREMENTS_NAMES },
  { tool: 'forge_releases', names: RELEASES_NAMES },
  { tool: 'forge_release', names: RELEASES_NAMES },
  { tool: 'forge_metrics_project_step_durations', names: METRICS_NAMES },
  { tool: 'forge_metrics_project_timeseries', names: METRICS_NAMES },
  { tool: 'forge_requirement_draft', keys: ['preview', 'taken'], names: DOCUMENT_NAMES },
  { tool: 'forge_decisions', names: DECISION_NAMES },
  { tool: 'ba_read_requirement', names: REQUIREMENTS_NAMES },
  {
    tool: 'ba_find_similar',
    names: [...REQUIREMENTS_NAMES, /\bsimilar(?:ity)?\b|tương\s+tự/iu], // i18n-allow: the Vietnamese word for similar
  },
  { tool: 'ba_read_journeys', names: [/\bjourneys?\b|hành\s+trình/iu] }, // i18n-allow: the Vietnamese word for a journey
  { tool: MEMORY_TOOL },
];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const named = (name: string, tool: string): boolean => name === tool || name.endsWith(`__${tool}`);

/**
 * Each landed result a declared read returned, by the read's own name and cut to the part of it
 * that grounds a figure. A refused call grounds nothing.
 */
export function groundingReads(results: readonly ToolResultEntry[]): ToolResultEntry[] {
  const out: ToolResultEntry[] = [];
  for (const r of results) {
    if (r.isError === true) continue;
    const declared = FIGURE_READS.find((d) => named(r.name, d.tool));
    if (!declared) continue;
    if (!declared.keys) {
      out.push({ name: declared.tool, text: r.text });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.text);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    for (const key of declared.keys) {
      if (parsed[key] !== undefined) {
        out.push({ name: declared.tool, text: JSON.stringify(parsed[key]) });
      }
    }
  }
  return out;
}

const byNames =
  (names: readonly RegExp[], tool: string) =>
  (passage: string): boolean =>
    passage.includes(tool) || names.some((re) => re.test(passage));

/**
 * Every source a figure of this turn can come from: the report runs as one, where the turn read
 * any, and each declared read it made, one per read whatever number of calls made it.
 */
export function figureSourcesOf(
  frames: readonly ReportFrame[],
  reads: readonly ToolResultEntry[],
): FigureSource[] {
  const sources: FigureSource[] = [];
  if (frames.length > 0) {
    sources.push({
      read: REPORT_SOURCE,
      values: atDecimals(frameValues(frames)),
      namedIn: byNames(REPORT_NAMES, 'forge_report'),
    });
  }
  const texts = new Map<string, string[]>();
  for (const r of reads) texts.set(r.name, [...(texts.get(r.name) ?? []), r.text]);
  for (const [tool, results] of texts) {
    const declared = FIGURE_READS.find((d) => d.tool === tool);
    if (!declared) continue;
    const dates = memoryDatesRead(results);
    sources.push({
      read: tool,
      values: atDecimals(results.flatMap(valuesOfResult)),
      namedIn: declared.names
        ? byNames(declared.names, tool)
        : (passage) => namesDateOf(passage, dates),
    });
  }
  return sources;
}

const LIST_LINE_RE = /^\s*(?:[-*+•]|\d+[.)]|\|)/;
const HEADING_RE = /^\s*(?:#{1,6}\s+\S|\*\*[^*\n]+\*\*\s*:?\s*$)/;
const SOURCES_LINE_RE = /^\s*[*_]*\s*(?:sources?|nguồn)\s*[*_]*\s*:/iu; // i18n-allow: the Vietnamese word for sources

/** The paragraphs of a text, each with where it starts; a blank line ends one. */
function paragraphsOf(text: string): { start: number; text: string }[] {
  const out: { start: number; text: string }[] = [];
  const re = /\n[ \t]*\n/g;
  let start = 0;
  for (const m of text.matchAll(re)) {
    out.push({ start, text: text.slice(start, m.index ?? 0) });
    start = (m.index ?? 0) + m[0].length;
  }
  out.push({ start, text: text.slice(start) });
  return out;
}

/** Every `Sources:` line with the list under it, as one passage. */
function sourcesPassages(text: string): string[] {
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!SOURCES_LINE_RE.test(lines[i] ?? '')) continue;
    const block = [lines[i] ?? ''];
    for (let j = i + 1; j < lines.length && LIST_LINE_RE.test(lines[j] ?? ''); j++) {
      block.push(lines[j] ?? '');
    }
    out.push(block.join('\n'));
  }
  return out;
}

/** The nearest heading above `index`, or nothing. */
function headingAbove(text: string, index: number): string {
  const lines = text.slice(0, index).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (HEADING_RE.test(lines[i] ?? '')) return lines[i] ?? '';
  }
  return '';
}

/**
 * The passages that may name the read behind the figure at `index`: its paragraph, the paragraph
 * before it where that one introduces it, the heading it sits under, and every `Sources:` block.
 */
export function passagesAround(text: string, index: number): string[] {
  const paragraphs = paragraphsOf(text);
  let at = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    if ((paragraphs[i]?.start ?? 0) <= index) at = i;
  }
  const own = paragraphs[at]?.text ?? '';
  const before = at > 0 ? (paragraphs[at - 1]?.text ?? '').trimEnd() : '';
  return [
    own,
    ...(before.endsWith(':') ? [before] : []),
    headingAbove(text, index),
    ...sourcesPassages(text),
  ].filter((p) => p.trim().length > 0);
}

/** What the breaking figure was read from, as the reply could name it. */
function readNames(sources: readonly FigureSource[]): string {
  const say: Record<string, string> = {
    [REPORT_SOURCE]: 'the report run (or the block that shows it)',
    forge_project_status: 'the project status',
    forge_requirements: 'the requirements list or the REQ-n it is about',
    forge_requirement: 'the REQ-n it was read from',
    forge_releases: 'the releases list or the release version',
    forge_release: 'the release by its version',
    forge_decisions: 'the decisions',
    forge_requirement_draft: 'the attached file by its name',
  };
  return [...new Set(sources.map((s) => say[s.read] ?? s.read))].join(' or ');
}

function breakFor(figure: StatedFigure, holding: readonly FigureSource[]): RuleBreak {
  const q = figure.quote;
  if (holding.every((s) => s.read === MEMORY_TOOL)) {
    return {
      quote: q,
      why: `the reply states the figure ${q}, which only a memory read this turn holds, as if it held now — a memory is a record of its date: say "a memory of <its asOf date> records ${q} …", or read it live and name that read`,
    };
  }
  return {
    quote: q,
    why: `the reply states the figure ${q} and names no read it came from — name ${readNames(holding)} in its sentence, in the line that introduces it, or in a closing "Sources:" line`,
  };
}

export const FIGURES_NAME_SOURCE: MessageRule = {
  id: 'figures-name-source',
  shape:
    'a figure a read of this turn returned names that read: in its paragraph, the line or heading that introduces it, or a "Sources:" line (the project status, REQ-n, a release by version, the decisions, the report or the table above, the attached file); a figure from memory is "a memory of <its date> records …"',
  example: '12 issues are in flight (project status, read now).',
  needs: ['report-runs'],
  check: (text, f) => {
    const facts: FigureFacts | null = f.figures;
    if (!facts || facts.sources.length === 0) return [];
    const scan = blankMarkedClauses(text).normalize('NFC');
    const breaks: RuleBreak[] = [];
    for (const fig of statedFigures(scan)) {
      if (askersOwn(scan, fig, facts.asked)) continue;
      const holding = facts.sources.filter((s) => holds(fig, s.values));
      if (holding.length === 0) continue;
      const passages = passagesAround(scan, fig.index);
      if (holding.some((s) => passages.some((p) => s.namedIn(p)))) continue;
      breaks.push(breakFor(fig, holding));
    }
    return breaks;
  },
};
