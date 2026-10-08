// The ReportQuery port: data by code. A query is typed, permission-checked and returns one frame; a
// block draws a frame and never knows which query made it. Core's `report-queries` module registers
// the queries, the `reports` module runs them, and web and the doors read the shapes here.

import { z } from "zod";
import { PROJECT_PERMISSIONS } from "./permissions.js";

export const REPORT_FIELD_TYPES = [
  "string",
  "number",
  "date",
  "duration",
  "status",
  "ref",
] as const;
export type ReportFieldType = (typeof REPORT_FIELD_TYPES)[number];

/** `rest` is the door every query has; `chat` and `cli` are the one-question-one-answer surfaces. */
export const REPORT_SURFACES = ["rest", "chat", "cli"] as const;
export type ReportSurface = (typeof REPORT_SURFACES)[number];

/** The class of the rows under `lib/data-egress.ts`: an operational source is withheld at no_egress. */
export const REPORT_EGRESS_CLASSES = ["product", "operational"] as const;
export type ReportEgressClass = (typeof REPORT_EGRESS_CLASSES)[number];

/** A stable id: lower-case words joined by single hyphens. */
export const REPORT_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const NAME = z.string().min(1).max(64);

export const ReportFieldSchema = z
  .object({
    name: NAME,
    type: z.enum(REPORT_FIELD_TYPES),
    unit: z.string().min(1).max(24).optional(),
    label: z.string().min(1).max(80),
  })
  .strict();
export type ReportField = z.infer<typeof ReportFieldSchema>;

/** A `ref` cell is an entity key (ISS-12, REQ-3, FB-9, a release version); a duration is milliseconds, a date ISO 8601. */
export const ReportCellSchema = z.union([z.string(), z.number().finite(), z.null()]);
export type ReportCell = z.infer<typeof ReportCellSchema>;

function cellFits(type: ReportFieldType, cell: ReportCell): boolean {
  if (cell === null) return true;
  return type === "number" || type === "duration" ? typeof cell === "number" : typeof cell === "string";
}

/** The one interchange shape between a query and a block, after Grafana's data frame. */
export const ReportFrameSchema = z
  .object({
    fields: z.array(ReportFieldSchema).min(1).max(64),
    rows: z.array(z.record(z.string(), ReportCellSchema)).max(5000),
  })
  .strict()
  .superRefine((frame, ctx) => {
    const seen = new Set<string>();
    for (const [i, f] of frame.fields.entries()) {
      if (seen.has(f.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["fields", i, "name"],
          message: `field "${f.name}" is declared twice; a frame names each field once`,
        });
      }
      seen.add(f.name);
    }
    const byName = new Map(frame.fields.map((f) => [f.name, f]));
    for (const [r, row] of frame.rows.entries()) {
      for (const f of frame.fields) {
        if (!Object.hasOwn(row, f.name)) {
          ctx.addIssue({
            code: "custom",
            path: ["rows", r, f.name],
            message: `row ${r} has no cell for field "${f.name}"; every row holds one cell per field, null for none`,
          });
        }
      }
      for (const [name, cell] of Object.entries(row)) {
        const field = byName.get(name);
        if (!field) {
          ctx.addIssue({
            code: "custom",
            path: ["rows", r, name],
            message: `row ${r} holds a cell "${name}" that no field declares; declared: ${[...byName.keys()].join(", ")}`,
          });
        } else if (!cellFits(field.type, cell)) {
          ctx.addIssue({
            code: "custom",
            path: ["rows", r, name],
            message: `row ${r} cell "${name}" is ${typeof cell}, but the field is ${field.type}; a ${field.type} cell is ${
              field.type === "number" || field.type === "duration" ? "a number" : "a string"
            } or null`,
          });
        }
      }
    }
  });
export type ReportFrame = z.infer<typeof ReportFrameSchema>;

/** A project permission: a report is never readable below `project.read`, and every project permission holds it. */
export const ReportPermissionSchema = z.enum(PROJECT_PERMISSIONS);

/**
 * What a query declares about itself. `params` is a zod object; `defineReportQuery` refuses the
 * descriptor that does not meet the rest.
 */
export interface ReportQueryDescriptor<P extends z.ZodObject = z.ZodObject> {
  /** Stable, kebab-case. */
  id: string;
  /** An integer bumped on any change to the output. */
  version: number;
  title: string;
  params: P;
  /** The fields of the frame the query returns, declared before it runs so a template can be checked against them. */
  output: readonly ReportField[];
  permission: z.infer<typeof ReportPermissionSchema>;
  egress: ReportEgressClass;
  surfaces: readonly ReportSurface[];
}

/** The part of a descriptor that crosses the wire; `params` is carried as its JSON Schema. */
export const ReportQueryDescriptorViewSchema = z
  .object({
    id: z.string().regex(REPORT_ID_PATTERN),
    version: z.number().int().min(1),
    title: z.string().min(1).max(120),
    params: z.record(z.string(), z.unknown()),
    output: z.array(ReportFieldSchema).min(1),
    permission: ReportPermissionSchema,
    egress: z.enum(REPORT_EGRESS_CLASSES),
    surfaces: z.array(z.enum(REPORT_SURFACES)).min(1),
  })
  .strict();
export type ReportQueryDescriptorView = z.infer<typeof ReportQueryDescriptorViewSchema>;

function refusal(id: string, why: string): never {
  throw new Error(`report query "${id}": ${why}`);
}

/** Returns the descriptor, or throws naming the query and what was wrong. */
export function defineReportQuery<P extends z.ZodObject>(
  d: ReportQueryDescriptor<P>,
): ReportQueryDescriptor<P> {
  if (!REPORT_ID_PATTERN.test(d.id)) {
    refusal(d.id, `id must be kebab-case (lower-case words joined by single hyphens), e.g. "progress-by-requirement"`);
  }
  if (!Number.isInteger(d.version) || d.version < 1) {
    refusal(d.id, `version must be an integer of at least 1, got ${String(d.version)}`);
  }
  if (d.title.trim().length === 0) refusal(d.id, "title is empty");
  if (d.surfaces.length === 0) refusal(d.id, `surfaces is empty; name at least one of ${REPORT_SURFACES.join(", ")}`);
  for (const s of d.surfaces) {
    if (!REPORT_SURFACES.includes(s)) refusal(d.id, `surface "${s}" is not one of ${REPORT_SURFACES.join(", ")}`);
  }
  if (!PROJECT_PERMISSIONS.includes(d.permission)) {
    refusal(d.id, `permission "${d.permission}" is not a project permission; a report needs at least project.read`);
  }
  if (d.output.length === 0) refusal(d.id, "output declares no fields");
  const names = new Set<string>();
  for (const f of d.output) {
    const parsed = ReportFieldSchema.safeParse(f);
    if (!parsed.success) refusal(d.id, `output field ${JSON.stringify(f.name)} is invalid: ${parsed.error.message}`);
    if (names.has(f.name)) refusal(d.id, `output declares field "${f.name}" twice`);
    names.add(f.name);
  }
  return d;
}

/** Parses a run's params, refusing an unknown key by name. */
export function parseReportParams<P extends z.ZodObject>(
  d: ReportQueryDescriptor<P>,
  input: unknown,
): z.infer<P> {
  const parsed = d.params.strict().safeParse(input ?? {});
  if (!parsed.success) {
    const why = parsed.error.issues
      .map((i) => `${i.path.length > 0 ? `${i.path.join(".")}: ` : ""}${i.message}`)
      .join("; ");
    refusal(d.id, `params refused: ${why}`);
  }
  return parsed.data as z.infer<P>;
}

/** Every figure carries the query and the read that produced it. */
export const ReportRunSchema = z
  .object({
    runId: z.string().min(1),
    queryId: z.string().regex(REPORT_ID_PATTERN),
    version: z.number().int().min(1),
    params: z.record(z.string(), z.unknown()),
    projectId: z.string().min(1),
    actor: z.object({ kind: z.enum(["human", "agent"]), id: z.string().min(1) }).strict(),
    asOf: z.iso.datetime(),
    frame: ReportFrameSchema,
  })
  .strict();
export type ReportRun = z.infer<typeof ReportRunSchema>;
