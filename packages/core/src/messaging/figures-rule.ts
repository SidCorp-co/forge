/**
 * A figure a chat reply states — in its prose, or typed into a visual block's title or labels,
 * flow labels included — has to be one a report run of this turn holds (REQ-32 criteria 5 and 6):
 * a run this turn made through `forge_report` or `forge_template`, or in Agent mode through the
 * REST runs routes, or the run a block this turn drew names. Otherwise the reply is held, quoting the
 * figure. What a number is when it is not a figure is `figure-exemptions.ts`'s table.
 *
 * A turn that could run no report (a door without the report tools, a synthesis turn) has nothing
 * to hold a figure to, and is not judged: `facts.figures` is null there.
 */

import type { ReportFrame } from '@forge/contracts/report-queries';
import type { MessageRule, RuleBreak } from './contract.js';
import type { FigureFacts, MessageFacts } from './facts.js';
import { askedValues, figuresIn, type StatedFigure, statedFigures } from './figure-exemptions.js';
import { blankMarkedClauses } from './reply-marks.js';

/** The chat tools that run a report; a turn offered neither cannot ground a figure in one. */
export const REPORT_TOOLS: readonly string[] = ['forge_report', 'forge_template'];

/** Whether `name` is one of the report tools, as a chat turn or an MCP client names it. */
export const isReportTool = (name: string): boolean =>
  REPORT_TOOLS.some((t) => name === t || name.endsWith(`__${t}`));

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

/**
 * What the figures rule holds a reply to: every number the runs' frames hold, rounded at each of
 * DECIMALS. A duration (milliseconds) is held in seconds, minutes, hours, days and weeks too; a
 * frame's row count is one of its figures; a string cell gives the figures it states.
 */
export function figureFactsOf(asked: string, frames: readonly ReportFrame[]): FigureFacts {
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
  const held = DECIMALS.map((d) => new Set(values.map((v) => round(v, d))));
  return { asked: askedValues(asked), runs: frames.length, held };
}

/** Whether a reading of the figure is a value the runs hold, at the decimals it is stated to. */
function grounded(figure: StatedFigure, f: FigureFacts): boolean {
  return figure.readings.some((r) => {
    if (f.asked.has(r.value)) return true;
    const at = f.held[Math.min(r.decimals, DECIMALS.length - 1)];
    return at?.has(round(r.value, Math.min(r.decimals, DECIMALS.length - 1))) ?? false;
  });
}

const ASK_FOR_A_RUN =
  'call forge_report or forge_template (in Agent mode, POST /api/projects/<id>/report-queries/<query>/runs) and state the figure its frame returns, or leave it out';

function proseBreak(figure: StatedFigure, f: FigureFacts): RuleBreak {
  return {
    quote: figure.quote,
    why:
      f.runs === 0
        ? `the reply states the figure ${figure.quote} and this turn ran no report — ${ASK_FOR_A_RUN}`
        : `the reply states the figure ${figure.quote}, and none of the ${f.runs} report run(s) this turn read holds it — state only figures their frames returned, or leave it out`,
  };
}

type Call = MessageFacts['toolCalls'][number];

/** A text a block this turn drew was given: its title or a label, where it was typed. */
interface BlockText {
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

/** Every title and label the turn's blocks were given, as typed. */
export function blockTextsOf(calls: readonly Call[]): BlockText[] {
  const out: BlockText[] = [];
  for (const c of calls) {
    const body = blockBody(c);
    if (body === null) continue;
    const kind = KIND_RE.exec(body)?.[1] ?? 'visual';
    for (const m of body.matchAll(TEXT_KEY_RE)) {
      let text = m[2] ?? '';
      try {
        text = JSON.parse(`"${text}"`) as string;
      } catch {
        // the label stands as written
      }
      out.push({ kind, key: m[1] ?? 'label', text });
    }
  }
  return out;
}

function blockBreaks(calls: readonly Call[], f: FigureFacts): RuleBreak[] {
  const breaks: RuleBreak[] = [];
  for (const b of blockTextsOf(calls)) {
    for (const figure of figuresIn(b.text)) {
      if (grounded(figure, f)) continue;
      breaks.push({
        quote: figure.quote,
        why: `the ${b.kind} block's ${b.key} "${b.text}" states the figure ${figure.quote}, and no report run this turn holds it — a block's text holds no figure of its own: show the figure from its run's frame, or take it out of the ${b.key}`,
      });
    }
  }
  return breaks;
}

export const FIGURES_GROUNDED: MessageRule = {
  id: 'figures-grounded',
  shape:
    'state a figure, in the reply or in a block, only as a report run this turn returned it; dates, ids, versions, ordinals, quoted sources and the numbers the person typed are not figures',
  example: 'The table above holds the figures, read from the report this turn ran.',
  needs: ['report-runs'],
  check: (text, f) => {
    const held = f.figures;
    if (!held) return [];
    const said = statedFigures(blankMarkedClauses(text)).filter((fig) => !grounded(fig, held));
    return [...said.map((fig) => proseBreak(fig, held)), ...blockBreaks(f.toolCalls, held)];
  },
};
