// The Template port: declarative data. A template names the queries to run, the blocks to draw
// over their frames and the narrative slots a model fills. It is data, never code: no expression,
// formula, function or conditional exists in its schema, and a derived column is a query's job.
// Built-in templates are contract data; a project's own, saved later, pass the same validator, so
// a project template can do nothing a built-in cannot.

import { z } from "zod";
import {
  REPORT_ID_PATTERN,
  type ReportField,
  ReportRunSchema,
} from "./report-queries.js";
import {
  type BlockRefusal,
  ChartSpecSchema,
  checkBlockSpec,
  FlowSpecSchema,
  KpiSpecSchema,
  StatusListSpecSchema,
  TableSpecSchema,
  TimelineSpecSchema,
  VisualBlockSchema,
} from "./visual-blocks.js";

const ID = z.string().regex(REPORT_ID_PATTERN);
const NAME = z.string().regex(/^[a-z][A-Za-z0-9]*$/, "a name is camelCase letters and digits");

export const TEMPLATE_NARRATIVE_SLOTS = ["summary", "risks", "recommendations"] as const;
export type TemplateNarrativeSlot = (typeof TEMPLATE_NARRATIVE_SLOTS)[number];
export const TEMPLATE_PARAM_TYPES = ["string", "number", "boolean"] as const;
export const TEMPLATE_MAX_QUERIES = 12;
export const TEMPLATE_MAX_BLOCKS = 24;
export const NARRATIVE_MAX_WORDS = 400;

const Literal = z.union([z.string().max(200), z.number().finite(), z.boolean()]);

/** A template param: a declared name with a type and an optional default; nothing is computed. */
export const TemplateParamSchema = z
  .object({
    type: z.enum(TEMPLATE_PARAM_TYPES),
    label: z.string().min(1).max(80),
    default: Literal.optional(),
  })
  .strict();

/** A query param is a literal, or the name of a template param, and nothing else. */
export const TemplateBindingSchema = z.union([
  z.object({ literal: Literal }).strict(),
  z.object({ param: NAME }).strict(),
]);

export const TemplateQuerySchema = z
  .object({
    as: NAME,
    query: ID,
    params: z.record(z.string(), TemplateBindingSchema),
  })
  .strict();

/** A layout block is a block spec that names the `as` of the run it draws instead of a run id. */
const LAYOUT = { as: NAME };
export const TemplateBlockSchema = z.discriminatedUnion("kind", [
  TableSpecSchema.extend(LAYOUT),
  ChartSpecSchema.extend(LAYOUT),
  FlowSpecSchema.extend(LAYOUT),
  TimelineSpecSchema.extend(LAYOUT),
  KpiSpecSchema.extend(LAYOUT),
  StatusListSpecSchema.extend(LAYOUT),
]);

export const TemplateNarrativeSchema = z
  .object({
    slot: z.enum(TEMPLATE_NARRATIVE_SLOTS),
    guidance: z.string().min(1).max(300),
    maxWords: z.number().int().min(1).max(NARRATIVE_MAX_WORDS),
  })
  .strict();

export const ReportTemplateSchema = z
  .object({
    id: ID,
    version: z.number().int().min(1),
    title: z.string().min(1).max(120),
    params: z.record(NAME, TemplateParamSchema),
    queries: z.array(TemplateQuerySchema).min(1).max(TEMPLATE_MAX_QUERIES),
    layout: z.array(TemplateBlockSchema).min(1).max(TEMPLATE_MAX_BLOCKS),
    narrative: z.array(TemplateNarrativeSchema).max(TEMPLATE_NARRATIVE_SLOTS.length),
  })
  .strict();
export type ReportTemplate = z.infer<typeof ReportTemplateSchema>;

/** The longest name a document carries: a shared chat answer is named by its question, trimmed to this. */
export const REPORT_DOCUMENT_TITLE_MAX = 160;
/** The longest reply a shared chat answer freezes, in characters of Markdown. */
export const REPORT_DOCUMENT_REPLY_MAX = 40_000;

/** What a template produces: what the chat shows, what status-reports stores and what a share freezes. */
export const ReportDocumentSchema = z
  .object({
    templateId: ID,
    version: z.number().int().min(1),
    params: z.record(z.string(), Literal),
    runs: z.array(ReportRunSchema),
    blocks: z.array(VisualBlockSchema),
    narrative: z.record(z.enum(TEMPLATE_NARRATIVE_SLOTS), z.string()),
    /** The document's name where it has one of its own: a shared chat answer's question. A template's output is named by its template. */
    title: z.string().min(1).max(REPORT_DOCUMENT_TITLE_MAX).optional(),
    /** A shared chat answer's reply, as the room was shown it, in Markdown; drawn above the blocks. */
    reply: z.string().min(1).max(REPORT_DOCUMENT_REPLY_MAX).optional(),
  })
  .strict();
export type ReportDocument = z.infer<typeof ReportDocumentSchema>;

/** What the validator needs to know of a registered query: the fields its frame will hold, and the params it takes. */
export interface KnownQuery {
  output: readonly ReportField[];
  params: readonly string[];
}

export interface TemplateRefusal {
  field: string;
  message: string;
}

const refuse = (field: string, why: string): TemplateRefusal => ({
  field,
  message: `report template: ${field}: ${why}`,
});

const fromBlock = (at: string, r: BlockRefusal): TemplateRefusal => ({
  field: `${at}.${r.field}`,
  message: `report template: ${at}: ${r.message}`,
});

/**
 * Validates a template, as data. Refuses by name an unknown key, an unknown query id, a param
 * binding that is not a declared name, a block that names no run, and a block whose kind finds the
 * frame not sensible. An empty list is a valid template.
 */
export function validateTemplate(
  raw: unknown,
  queries: ReadonlyMap<string, KnownQuery>,
): TemplateRefusal[] {
  const parsed = ReportTemplateSchema.safeParse(raw);
  if (!parsed.success) {
    return parsed.error.issues.map((i) =>
      i.code === "unrecognized_keys"
        ? refuse(
            [...i.path, ...i.keys].join("."),
            `unknown key; a template is data and holds only id, version, title, params, queries, layout and narrative`,
          )
        : refuse(i.path.length > 0 ? i.path.join(".") : "(template)", i.message),
    );
  }
  const t = parsed.data;
  const out: TemplateRefusal[] = [];
  const bound = new Map<string, KnownQuery>();
  for (const [i, q] of t.queries.entries()) {
    const at = `queries.${i}`;
    if (bound.has(q.as)) out.push(refuse(`${at}.as`, `"${q.as}" names two queries`));
    const known = queries.get(q.query);
    if (!known) {
      out.push(
        refuse(
          `${at}.query`,
          `unknown query "${q.query}"; registered: ${[...queries.keys()].join(", ") || "(none)"}`,
        ),
      );
      continue;
    }
    bound.set(q.as, known);
    for (const [name, binding] of Object.entries(q.params)) {
      if (!known.params.includes(name)) {
        out.push(refuse(`${at}.params.${name}`, `query "${q.query}" takes no param "${name}"; it takes: ${known.params.join(", ") || "(none)"}`));
      }
      if ("param" in binding && !Object.hasOwn(t.params, binding.param)) {
        out.push(
          refuse(
            `${at}.params.${name}`,
            `binds "${binding.param}", which the template does not declare; declared: ${Object.keys(t.params).join(", ") || "(none)"}`,
          ),
        );
      }
    }
  }
  for (const [i, block] of t.layout.entries()) {
    const at = `layout.${i}`;
    const query = bound.get(block.as);
    if (!query) {
      out.push(refuse(`${at}.as`, `"${block.as}" names no query of this template; queries: ${[...bound.keys()].join(", ") || "(none)"}`));
      continue;
    }
    const { as: _as, ...spec } = block;
    for (const r of checkBlockSpec(spec, { fields: query.output })) out.push(fromBlock(at, r));
  }
  const slots = new Set<string>();
  for (const [i, n] of t.narrative.entries()) {
    if (slots.has(n.slot)) out.push(refuse(`narrative.${i}.slot`, `slot "${n.slot}" is given twice`));
    slots.add(n.slot);
  }
  return out;
}
