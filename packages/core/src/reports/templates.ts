// A template run: the template's queries are run as the asker through `runReport` (so each is a
// stored run a block can name), its layout is drawn over those frames, and what the model writes is
// left to it: the slots come back empty with their guidance. A template is contract data; this is
// the only code that reads it. A narrative is checked here against what the template's own blocks
// show of its own runs and no others, so a figure the runs never returned, or one they hold that no
// block of the report shows its reader, is refused by name before it is written.

import type { ActorAgency } from '@forge/contracts/permissions';
import type { ReportRefusalCode, ReportRun, ReportSurface } from '@forge/contracts/report-queries';
import {
  BUILTIN_REPORT_TEMPLATES,
  builtinReportTemplate,
} from '@forge/contracts/report-template-builtins';
import {
  type ReportDocument,
  type ReportTemplate,
  TEMPLATE_NARRATIVE_SLOTS,
  type TemplateNarrativeSlot,
  validateTemplate,
} from '@forge/contracts/report-templates';
import {
  blockToText,
  UTC_READING,
  checkBlock,
  shownFrame,
  VISUAL_BLOCK_VERSION,
  type VisualBlock,
} from '@forge/contracts/visual-blocks';
import { refuser } from '../lib/refusal.js';
import { type ReportAsker, reportsPorts } from './ports.js';
import { readReportRun, runReport } from './runs.js';

const refuse = refuser<ReportRefusalCode>('REPORT_REFUSED');

type Literal = string | number | boolean;

/** A block the template lays out that the run's frame could not fill, said so and never dropped quietly. */
export interface NotDrawn {
  index: number;
  kind: string;
  as: string;
  why: string;
}

export interface TemplateSlot {
  slot: TemplateNarrativeSlot;
  guidance: string;
  maxWords: number;
}

export interface TemplateRun {
  document: ReportDocument;
  /** What to write, slot by slot, from what `document.blocks` show alone. */
  slots: TemplateSlot[];
  notDrawn: NotDrawn[];
  /** The blocks as plain text, as a door that draws none reads them. */
  text: string;
}

/** The templates this build offers, for a listing and a tool description. */
export const listReportTemplates = (): {
  id: string;
  version: number;
  title: string;
  params: string[];
}[] =>
  BUILTIN_REPORT_TEMPLATES.map((t) => ({
    id: t.id,
    version: t.version,
    title: t.title,
    params: Object.keys(t.params),
  }));

export function templateNamed(id: string): ReportTemplate {
  const t = builtinReportTemplate(id);
  if (t) return t;
  throw refuse(
    'REPORT_TEMPLATE_NOT_FOUND',
    `no report template "${id}"; templates: ${BUILTIN_REPORT_TEMPLATES.map((x) => x.id).join(', ')}`,
    '/templateId',
  );
}

/** A template is judged against the registry it will run over before anything is read. */
function assertRunnable(t: ReportTemplate): void {
  const known = new Map(
    reportsPorts()
      .listQueries()
      .map((q) => [
        q.id,
        { output: q.output, params: Object.keys((q.params as { shape: object }).shape) },
      ]),
  );
  const refusals = validateTemplate(t, known);
  if (refusals.length > 0) {
    throw new Error(
      `report template "${t.id}" does not hold against the registered queries: ${refusals.map((r) => r.message).join('; ')}`,
    );
  }
}

/** The declared params, given or defaulted; a name the template does not declare, or a wrong type, is refused. */
function resolveParams(t: ReportTemplate, given: Record<string, unknown>): Record<string, Literal> {
  const declared = Object.keys(t.params);
  for (const name of Object.keys(given)) {
    if (!Object.hasOwn(t.params, name)) {
      throw refuse(
        'REPORT_TEMPLATE_PARAM_REFUSED',
        `template "${t.id}" takes no param "${name}"; it takes: ${declared.join(', ') || '(none)'}`,
        `/params/${name}`,
      );
    }
  }
  const out: Record<string, Literal> = {};
  for (const [name, spec] of Object.entries(t.params)) {
    const value = given[name] ?? spec.default;
    if (value === undefined) continue;
    if (typeof value !== spec.type) {
      throw refuse(
        'REPORT_TEMPLATE_PARAM_REFUSED',
        `template "${t.id}" param "${name}" is a ${spec.type}, and ${JSON.stringify(value)} is not`,
        `/params/${name}`,
      );
    }
    out[name] = value as Literal;
  }
  return out;
}

/** What each query of the template is run with: a literal, or the template param's value when it has one. */
function queryParams(t: ReportTemplate, params: Record<string, Literal>, as: string) {
  const q = t.queries.find((x) => x.as === as);
  const out: Record<string, Literal> = {};
  for (const [name, binding] of Object.entries(q?.params ?? {})) {
    if ('literal' in binding) out[name] = binding.literal;
    else if (Object.hasOwn(params, binding.param)) out[name] = params[binding.param] as Literal;
  }
  return out;
}

/** The blocks of a layout over the runs by `as`; a block over no rows that needs one is reported, any other refusal stands. */
function drawLayout(t: ReportTemplate, runs: ReadonlyMap<string, ReportRun>) {
  const blocks: VisualBlock[] = [];
  const notDrawn: NotDrawn[] = [];
  for (const [index, entry] of t.layout.entries()) {
    const { as, ...spec } = entry;
    const run = runs.get(as) as ReportRun;
    const raw = {
      v: VISUAL_BLOCK_VERSION,
      ...spec,
      source: { runId: run.runId },
      frame: run.frame,
    };
    if (run.frame.rows.length === 0 && (spec.kind === 'kpi' || spec.kind === 'timeline')) {
      notDrawn.push({
        index,
        kind: spec.kind,
        as,
        why: `query ${run.queryId} returned no rows at ${run.asOf}, so there is nothing for a ${spec.kind} to show`,
      });
      continue;
    }
    const checked = checkBlock(raw);
    if (!checked.ok) {
      throw refuse(
        'REPORT_BLOCK_REFUSED',
        `template "${t.id}" layout.${index} (${spec.kind} over ${as}): ${checked.refusals.map((r) => r.message).join('; ')}`,
        `/layout/${index}`,
      );
    }
    blocks.push(checked.block);
  }
  return { blocks, notDrawn };
}

/**
 * The document a template's runs make: its blocks over them, and the template params they were run
 * with, read back from the query params each run stored (a param bound to no query param is not kept).
 */
export function documentOf(
  t: ReportTemplate,
  runs: readonly ReportRun[],
  narrative: ReportDocument['narrative'],
): { document: ReportDocument; notDrawn: NotDrawn[] } {
  const params: Record<string, Literal> = {};
  for (const [i, q] of t.queries.entries()) {
    const stored = runs[i]?.params ?? {};
    for (const [name, binding] of Object.entries(q.params)) {
      const value = stored[name];
      if (
        'param' in binding &&
        (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      ) {
        params[binding.param] = value;
      }
    }
  }
  const byAs = new Map(t.queries.map((q, i) => [q.as, runs[i] as ReportRun]));
  const { blocks, notDrawn } = drawLayout(t, byAs);
  return {
    document: { templateId: t.id, version: t.version, params, runs: [...runs], blocks, narrative },
    notDrawn,
  };
}

const slotsOf = (t: ReportTemplate): TemplateSlot[] =>
  t.narrative.map(({ slot, guidance, maxWords }) => ({ slot, guidance, maxWords }));

const emptyNarrative = (): ReportDocument['narrative'] => ({
  summary: '',
  risks: '',
  recommendations: '',
});

/**
 * Runs one template for the asker: each of its queries through `runReport` on `surface`, then its
 * layout over their frames. Every figure of the document is one of those runs'.
 */
export async function runTemplate(args: {
  projectId: string;
  templateId: string;
  params?: Record<string, unknown> | undefined;
  asker: ReportAsker;
  surface: ReportSurface;
  now?: Date;
}): Promise<TemplateRun> {
  const t = templateNamed(args.templateId);
  assertRunnable(t);
  const params = resolveParams(t, args.params ?? {});
  const runs = new Map<string, ReportRun>();
  for (const q of t.queries) {
    runs.set(
      q.as,
      await runReport({
        projectId: args.projectId,
        queryId: q.query,
        params: queryParams(t, params, q.as),
        asker: args.asker,
        surface: args.surface,
        ...(args.now ? { now: args.now } : {}),
      }),
    );
  }
  const ordered = t.queries.map((q) => runs.get(q.as) as ReportRun);
  const { document, notDrawn } = documentOf(t, ordered, emptyNarrative());
  return {
    document,
    slots: slotsOf(t),
    notDrawn,
    text: document.blocks.map((b) => blockToText(b, UTC_READING)).join('\n\n'),
  };
}

const NUMBER = /\d[\d,]*(?:\.\d+)?/g;
const numeralsIn = (text: string): string[] =>
  (text.match(NUMBER) ?? []).map((n) => n.replaceAll(',', ''));

/**
 * Every number the report's blocks show: a numeric cell of a field a block draws, or digits inside
 * such a cell's text (REQ-12, a date), and the count of the rows it draws. A figure a run holds in a
 * field no block draws is not one of them: the narrative is read beside the blocks, in the chat, a
 * kept report, its export and a share, and none of them shows the run itself (ISS-419).
 */
function figuresShown(blocks: readonly VisualBlock[]): Set<string> {
  const held = new Set<string>();
  for (const block of blocks) {
    const frame = shownFrame(block);
    if (!frame) continue;
    held.add(String(frame.rows.length));
    for (const row of frame.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell === 'number') held.add(String(cell));
        else if (typeof cell === 'string') for (const n of numeralsIn(cell)) held.add(n);
      }
    }
  }
  return held;
}

/** Each block a reader can check a figure against, named as a refusal names it. */
const blocksNamed = (blocks: readonly VisualBlock[]): string =>
  blocks
    .filter((b) => shownFrame(b) !== null)
    .map((b) => `${b.kind}${b.title ? ` "${b.title}"` : ''}`)
    .join('; ');

const wordsIn = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

/**
 * Judges a narrative against what the template's blocks show of its own runs: the runs are those of
 * this template's queries, in its order, read back as the asker, and the blocks its layout draws over
 * them; a slot the template does not declare, one over its word cap, or a number no block shows is
 * refused by name. Answers the document with the narrative set.
 */
export async function checkTemplateNarrative(args: {
  projectId: string;
  templateId: string;
  runIds: readonly string[];
  narrative: Partial<Record<TemplateNarrativeSlot, string | undefined>>;
  userId: string;
  agency: ActorAgency;
  now?: Date;
}): Promise<ReportDocument> {
  const t = templateNamed(args.templateId);
  const runs = await readTemplateRuns(t, args);
  const declared = new Map(t.narrative.map((n) => [n.slot, n]));
  const { blocks } = documentOf(t, runs, emptyNarrative()).document;
  const figures = figuresShown(blocks);
  const refusals: string[] = [];
  const narrative = emptyNarrative();
  for (const [slot, text] of Object.entries(args.narrative)) {
    if (
      !(TEMPLATE_NARRATIVE_SLOTS as readonly string[]).includes(slot) ||
      !declared.has(slot as TemplateNarrativeSlot)
    ) {
      refusals.push(
        `slot "${slot}" is not one template "${t.id}" declares; it declares: ${[...declared.keys()].join(', ')}`,
      );
      continue;
    }
    const spec = declared.get(slot as TemplateNarrativeSlot) as TemplateSlot;
    const said = text ?? '';
    if (wordsIn(said) > spec.maxWords) {
      refusals.push(
        `slot "${slot}" is ${wordsIn(said)} words and the template allows ${spec.maxWords}`,
      );
    }
    const stray = [...new Set(numeralsIn(said))].filter((n) => !figures.has(n));
    if (stray.length > 0) {
      refusals.push(
        `slot "${slot}" states ${stray.join(', ')}, which no block of template "${t.id}" shows; state only figures its blocks show of its runs (${blocksNamed(blocks)}; runs ${runs.map((r) => `${r.queryId} ${r.runId}`).join(', ')})`,
      );
    }
    narrative[slot as TemplateNarrativeSlot] = said;
  }
  if (refusals.length > 0) {
    throw refuse('REPORT_NARRATIVE_REFUSED', refusals.join('; '), '/narrative');
  }
  return documentOf(t, runs, narrative).document;
}

/**
 * The stored runs of a template, one per query in its order, read back as `userId`; a list that is
 * not this template's queries, in order, is refused naming both.
 */
export async function readTemplateRuns(
  t: ReportTemplate,
  args: {
    projectId: string;
    runIds: readonly string[];
    userId: string;
    agency: ActorAgency;
    now?: Date;
  },
): Promise<ReportRun[]> {
  if (args.runIds.length !== t.queries.length) {
    throw refuse(
      'REPORT_TEMPLATE_RUNS_MISMATCH',
      `template "${t.id}" runs ${t.queries.length} queries (${t.queries.map((q) => q.query).join(', ')}) and ${args.runIds.length} run id(s) were given; give the run of each, in that order`,
      '/runIds',
    );
  }
  const runs: ReportRun[] = [];
  for (const [i, runId] of args.runIds.entries()) {
    const run = await readReportRun({
      runId,
      userId: args.userId,
      agency: args.agency,
      projectId: args.projectId,
      ...(args.now ? { now: args.now } : {}),
    });
    const wanted = (t.queries[i] as ReportTemplate['queries'][number]).query;
    if (run.queryId !== wanted) {
      throw refuse(
        'REPORT_TEMPLATE_RUNS_MISMATCH',
        `run ${runId} is a ${run.queryId} run, and position ${i} of template "${t.id}" is ${wanted}; the template's own runs only`,
        `/runIds/${i}`,
      );
    }
    runs.push(run);
  }
  return runs;
}
