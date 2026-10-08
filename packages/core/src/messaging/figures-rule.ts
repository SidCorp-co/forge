/**
 * A figure a chat reply states — in its prose, or typed into a visual block's title or labels,
 * flow labels included — has to be one the turn read (REQ-32 criteria 5 and 6), or it is held,
 * quoting the figure. What a number is when it is not a figure is `figure-exemptions.ts`'s table.
 *
 * Two things ground a figure in the prose:
 * - a report run of this turn: one it made through `forge_report` or `forge_template`, or in Agent
 *   mode through the REST runs routes, or the run a block this turn drew names; an execution's frames
 *   (`forge_compute`, `POST /api/projects/:id/executions`) count as a run's do. Where the door shows
 *   the answer's blocks, a run's figure must also be one a block of this answer shows (ISS-419): the
 *   reader checks the prose against the blocks, never against the run, so a run's figure no block
 *   draws is held, and naming the run or its query in the prose does not let it through — the reader
 *   can open neither.
 * - the result of a read this file declares (`FIGURE_GROUNDING_RESULTS`), such as the project status
 *   or the count `forge_requirement_draft` took from an attached document (ISS-421). The list is
 *   declared, never "any tool": a tool that answers with what the model sent it would hand back a
 *   figure the model typed as its own ground, and a refused call grounds nothing. Like a creation
 *   claim under an unverified mark (`creation-claims-rule.ts`), a figure gets through on what the
 *   turn did, never on words the model put round it.
 *
 * A block's text holds no figure of its own: only a report run grounds a number in a title or label,
 * and a number the person typed grounds none (REQ-32 BC-5). In the prose, the person's number stands
 * only said back as theirs or declined (`figure-exemptions.ts:saidBackAt`), never stated as the
 * project's (REQ-32 BC-6).
 *
 * A turn that could run no report (a door without the report tools, a synthesis turn) has nothing
 * to hold a figure to, and is not judged: `facts.figures` is null there.
 */

import type { ReportFrame } from '@forge/contracts/report-queries';
import { checkBlock, shownFrame } from '@forge/contracts/visual-blocks';
import type { MessageRule, RuleBreak } from './contract.js';
import type { FigureFacts, MessageFacts, ToolResultEntry } from './facts.js';
import {
  askedValues,
  askersOwn,
  figuresIn,
  type StatedFigure,
  statedFigures,
} from './figure-exemptions.js';
import { blankMarkedClauses } from './reply-marks.js';

/** The chat tools that read a frame; a turn offered none cannot ground a figure in one. */
export const REPORT_TOOLS: readonly string[] = ['forge_report', 'forge_template', 'forge_compute'];

/** Whether `name` is one of the report tools, as a chat turn or an MCP client names it. */
export const isReportTool = (name: string): boolean =>
  REPORT_TOOLS.some((t) => name === t || name.endsWith(`__${t}`));

/**
 * The reads whose own result grounds a figure, and the part of the result that does: what code
 * computed from the project's records, or (`forge_requirement_draft`'s `preview` and `taken`) the
 * count code took from a document the person attached. Absent here on purpose: `forge_show`,
 * `forge_feedback`, `forge_requirement_revise` and `forge_memory_note`, which answer with what the
 * model sent them; `forge_memory`, a dated source and never a current fact (MJ-5); and `forge`, the
 * CLI, whose verbs write as well as read and whose output is no one shape.
 */
export const FIGURE_GROUNDING_RESULTS: readonly {
  readonly tool: string;
  readonly keys?: readonly string[];
}[] = [
  { tool: 'forge_project_status' },
  { tool: 'forge_requirements' },
  { tool: 'forge_requirement' },
  { tool: 'forge_releases' },
  { tool: 'forge_release' },
  { tool: 'forge_metrics_project_step_durations' },
  { tool: 'forge_metrics_project_timeseries' },
  { tool: 'forge_requirement_draft', keys: ['preview', 'taken'] },
];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const named = (name: string, tool: string): boolean => name === tool || name.endsWith(`__${tool}`);

/** The part of each landed result a declared read returned that grounds a figure, as text. */
export function groundingTexts(results: readonly ToolResultEntry[]): string[] {
  const out: string[] = [];
  for (const r of results) {
    if (r.isError === true) continue;
    const declared = FIGURE_GROUNDING_RESULTS.find((d) => named(r.name, d.tool));
    if (!declared) continue;
    if (!declared.keys) {
      out.push(r.text);
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
      if (parsed[key] !== undefined) out.push(JSON.stringify(parsed[key]));
    }
  }
  return out;
}

/** Every value a result states: its JSON numbers and the figures its strings state, or its text read whole. */
function valuesOfResult(text: string): number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return figuresIn(text).flatMap((f) => f.readings.map((r) => r.value));
  }
  const out: number[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'number') out.push(v);
    else if (typeof v === 'string') {
      for (const f of figuresIn(v)) for (const r of f.readings) out.push(r.value);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (isRecord(v)) Object.values(v).forEach(walk);
  };
  walk(parsed);
  return out;
}

/** The most run ids one screen looks up: a turn's results name issues and sessions by uuid too. */
const RUN_IDS_READ = 500;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** Every uuid these texts name, any of which may be a run this turn made or a block drew. */
export function runIdsIn(texts: readonly string[]): string[] {
  const ids = new Set<string>();
  for (const t of texts) {
    for (const m of t.matchAll(UUID_RE)) {
      ids.add(m[0].toLowerCase());
      if (ids.size >= RUN_IDS_READ) return [...ids];
    }
  }
  return [...ids];
}

/** The decimals a stated figure is matched to a run's value at: 41.67 is stated as 42 or 41.7. */
const DECIMALS = [0, 1, 2, 3] as const;

const UNIT_MS = [1000, 60_000, 3_600_000, 86_400_000, 604_800_000] as const;

const round = (n: number, d: number): number => Math.round(Math.abs(n) * 10 ** d) / 10 ** d;

const atDecimals = (values: readonly number[]): ReadonlySet<number>[] =>
  DECIMALS.map((d) => new Set(values.map((v) => round(v, d))));

/** Every number the frames hold: a duration in each unit too, a frame's row count, a string cell's figures. */
function frameValues(frames: readonly ReportFrame[]): number[] {
  const values: number[] = [];
  for (const frame of frames) {
    values.push(frame.rows.length);
    const durations = new Set(frame.fields.filter((f) => f.type === 'duration').map((f) => f.name));
    for (const row of frame.rows) {
      for (const [name, cell] of Object.entries(row)) {
        if (typeof cell === 'number') {
          values.push(cell);
          if (durations.has(name)) for (const unit of UNIT_MS) values.push(cell / unit);
        } else if (typeof cell === 'string') {
          for (const f of figuresIn(cell)) for (const r of f.readings) values.push(r.value);
        }
      }
    }
  }
  return values;
}

/**
 * What the figures rule holds a reply to: every number the runs' frames hold, and every value the
 * turn's grounding reads returned (`groundingTexts`), each rounded at each of DECIMALS. A duration
 * (milliseconds) is held in seconds, minutes, hours, days and weeks too; a frame's row count is one
 * of its figures; a string cell gives the figures it states.
 */
export function figureFactsOf(
  asked: string,
  frames: readonly ReportFrame[],
  reads: readonly string[] = [],
): FigureFacts {
  return {
    asked: askedValues(asked),
    runs: frames.length,
    held: atDecimals(frameValues(frames)),
    read: atDecimals(reads.flatMap(valuesOfResult)),
  };
}

/** Whether a reading of the figure is one of `sets`' values, at the decimals it is stated to. */
function holds(figure: StatedFigure, sets: readonly ReadonlySet<number>[]): boolean {
  return figure.readings.some((r) => {
    const d = Math.min(r.decimals, DECIMALS.length - 1);
    return sets[d]?.has(round(r.value, d)) ?? false;
  });
}

/** What the answer's blocks show of their frames, as figures; null where the door shows no block. */
function shownOf(heldBlocks: readonly string[] | null): readonly ReadonlySet<number>[] | null {
  if (heldBlocks === null) return null;
  const frames: ReportFrame[] = [];
  for (const raw of heldBlocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const checked = checkBlock(parsed);
    const frame = checked.ok ? shownFrame(checked.block) : null;
    if (frame) frames.push(frame);
  }
  return atDecimals(frameValues(frames));
}

const ASK_FOR_A_RUN =
  'call forge_report or forge_template (in Agent mode, POST /api/projects/<id>/report-queries/<query>/runs) and state the figure its frame returns, or leave it out';

function proseBreak(figure: StatedFigure, f: FigureFacts): RuleBreak {
  return {
    quote: figure.quote,
    why:
      f.runs === 0
        ? `the reply states the figure ${figure.quote}, and this turn ran no report and no read that returned it — ${ASK_FOR_A_RUN}`
        : `the reply states the figure ${figure.quote}, and none of the ${f.runs} report run(s) this turn read holds it, nor any read it made — state only figures their frames returned, or leave it out`,
  };
}

function unshownBreak(figure: StatedFigure): RuleBreak {
  return {
    quote: figure.quote,
    why: `the reply states the figure ${figure.quote}, which a report run of this turn holds and no block of this answer shows — the reader checks a figure against the blocks above the reply: draw the block that shows its field (forge_show over its run), or leave the figure out; naming the run does not show it`,
  };
}

type Call = MessageFacts['toolCalls'][number];

/** A text a block was given: its title or a label, where it was typed. */
export interface BlockText {
  readonly kind: string;
  readonly key: string;
  readonly text: string;
}

const BLOCK_ROUTE_RE = /conversations\/[^\s"'\\/]+\/blocks\b/;
const TEXT_KEY_RE = /"(title|label)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
const KIND_RE = /"kind"\s*:\s*"([\w-]+)"/;

/** What an Agent session's Bash call ran, or the arguments as given where they name no command. */
function commandOf(args: string): string {
  try {
    const command = (JSON.parse(args) as { command?: unknown }).command;
    return typeof command === 'string' ? command.replace(/\\"/g, '"') : args;
  } catch {
    return args;
  }
}

/** The body of a block a call drew: a `forge_show` call's arguments, or an Agent POST to the blocks route. */
function blockBody(c: Call): string | null {
  if (c.isError === true) return null;
  if (c.name === 'forge_show' || c.name.endsWith('__forge_show')) return c.arguments;
  if (c.name !== 'Bash') return null;
  const command = commandOf(c.arguments);
  return BLOCK_ROUTE_RE.test(command) ? command : null;
}

/** A block without the frame it carries: a frame's field labels are its run's, held to it by `figuresNotInRun`. */
function frameless(block: Record<string, unknown>): Record<string, unknown> {
  const { frame: _frame, ...rest } = block;
  return rest;
}

/** The body as JSON without a frame, where it is JSON; an Agent's shell command is read as written. */
function withoutFrame(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (!isRecord(parsed)) return body;
  return JSON.stringify(
    isRecord(parsed.block) ? { ...parsed, block: frameless(parsed.block) } : frameless(parsed),
  );
}

/** Every title and label one block's body was given, as typed: a block, a call's arguments or a command. */
export function blockTextsIn(raw: string): BlockText[] {
  const body = withoutFrame(raw);
  const kind = KIND_RE.exec(body)?.[1] ?? 'visual';
  const out: BlockText[] = [];
  for (const m of body.matchAll(TEXT_KEY_RE)) {
    let text = m[2] ?? '';
    try {
      text = JSON.parse(`"${text}"`) as string;
    } catch {
      // the label stands as written
    }
    out.push({ kind, key: m[1] ?? 'label', text });
  }
  return out;
}

/** Every title and label the turn's blocks were given, as typed. */
export function blockTextsOf(calls: readonly Call[]): BlockText[] {
  return calls.flatMap((c) => {
    const body = blockBody(c);
    return body === null ? [] : blockTextsIn(body);
  });
}

/**
 * Every figure a block's title or labels state that `f` does not hold: any number typed there that
 * the exemption table does not exempt, read without the prose grammar. The one check a block's text
 * passes, both when the block is attached (`reports/blocks.ts`, against its own run) and when the
 * reply it belongs to is screened (against every run of the turn).
 */
export function ungroundedBlockFigures(
  texts: readonly BlockText[],
  f: FigureFacts,
): { readonly text: BlockText; readonly figure: StatedFigure }[] {
  return texts.flatMap((text) =>
    figuresIn(text.text)
      .filter((figure) => !holds(figure, f.held))
      .map((figure) => ({ text, figure })),
  );
}

function blockBreaks(f: MessageFacts, held: FigureFacts): RuleBreak[] {
  const texts = f.heldBlocks ? f.heldBlocks.flatMap(blockTextsIn) : blockTextsOf(f.toolCalls);
  return ungroundedBlockFigures(texts, held).map(({ text: b, figure }) => ({
    quote: figure.quote,
    why: `the ${b.kind} block's ${b.key} "${b.text}" states the figure ${figure.quote}, and no report run this turn holds it — a block's text holds no figure of its own: show the figure from its run's frame, or take it out of the ${b.key}`,
  }));
}

export const FIGURES_GROUNDED: MessageRule = {
  id: 'figures-grounded',
  shape:
    "state a figure only as a report run this turn returned it and a block of the answer shows it, or as a read this turn made returned it; a block holds only its run's figures; dates, ids, versions, ordinals and quoted sources are not figures, and a number the person typed is theirs only said back as theirs, never stated as the project's",
  example: 'The table above holds the figures, read from the report this turn ran.',
  needs: ['report-runs'],
  check: (text, f) => {
    const held = f.figures;
    if (!held) return [];
    const shown = shownOf(f.heldBlocks);
    const breaks: RuleBreak[] = [];
    const scan = blankMarkedClauses(text).normalize('NFC');
    for (const fig of statedFigures(scan)) {
      if (askersOwn(scan, fig, held.asked) || holds(fig, held.read)) continue;
      if (!holds(fig, held.held)) breaks.push(proseBreak(fig, held));
      else if (shown !== null && !holds(fig, shown)) breaks.push(unshownBreak(fig));
    }
    return [...breaks, ...blockBreaks(f, held)];
  },
};
