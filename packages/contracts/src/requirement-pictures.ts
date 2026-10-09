// A requirement revision's kind and its one picture (REQ-35; Requirement lifecycle r14, steps
// picture, picture_none and picture_shown). The kind names what the requirement is; the picture is
// a rough sketch of it, chosen by that kind, shown at once with no accept, replaced in place by
// anyone who may edit the requirement, and read by no guard, checklist, turn rule or baseline.
// Core's CHECKs, REST and the web import the kinds, the content schemas and the view from here.

import { z } from "zod";
import { ReportFrameSchema } from "./report-queries.js";
import { ChartSpecSchema, checkBlockSpec, FlowSpecSchema } from "./visual-blocks.js";
import { parseWireframe } from "./wireframe.js";

/** What a requirement is, named by the assistant's draft and corrected by its author (r14 `draft`). */
export const REQUIREMENT_KINDS = ["process", "rule", "screen", "report"] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];

/** What a picture is drawn as. */
export const PICTURE_KINDS = ["flow", "example_table", "wireframe", "chart"] as const;
export type PictureKind = (typeof PICTURE_KINDS)[number];

/** The one picture each kind gets (r14 `picture`): process a flow (BC-3), rule an example table (BC-4), screen a wireframe, report a sample chart. */
export const PICTURE_KIND_OF = {
	process: "flow",
	rule: "example_table",
	screen: "wireframe",
	report: "chart",
} as const satisfies Record<RequirementKind, PictureKind>;

export const REQUIREMENT_PICTURE_LIMITS = {
	altChars: 300,
	titleChars: 120,
	tableRows: 50,
	cellChars: 500,
} as const;

const TITLE = z.string().trim().max(REQUIREMENT_PICTURE_LIMITS.titleChars);
const CELL = z.string().max(REQUIREMENT_PICTURE_LIMITS.cellChars);

/**
 * A rough flow: its own nodes and edges, as a flow block holds them. Where the requirement links a
 * workflow, the page draws that workflow with the steps its criteria trace highlighted (ISS-460);
 * the picture holds only what no link already says.
 */
const flowContent = FlowSpecSchema.omit({ kind: true }).superRefine((flow, ctx) => {
	for (const r of checkBlockSpec({ kind: "flow", ...flow }, { fields: [] })) {
		ctx.addIssue({ code: "custom", path: [r.field], message: r.message });
	}
});

/** A sample chart: a chart block's spec over a frame of hand-written figures, every one of them sample. */
const chartContent = ChartSpecSchema.omit({ kind: true })
	.extend({ frame: ReportFrameSchema })
	.superRefine(({ frame, ...spec }, ctx) => {
		for (const r of checkBlockSpec({ kind: "chart", ...spec }, frame)) {
			ctx.addIssue({ code: "custom", path: [r.field], message: r.message });
		}
	});

/** A wireframe: one wireframe-v1 board, judged by `parseWireframe`, whose refusal names the shape and the field. */
const wireframeContent = z.strictObject({ board: z.unknown() }).superRefine(({ board }, ctx) => {
	const parsed = parseWireframe(board);
	if (!parsed.ok) ctx.addIssue({ code: "custom", path: ["board"], message: parsed.message });
});

/**
 * An example table: each row an input and the result it is expected to give (BC-4). A blank or
 * missing cell is taken here and refused by name in core (REQUIREMENT_PICTURE_ROW_INCOMPLETE), so
 * the refusal says which row lacks which half rather than that the body is malformed.
 */
const exampleTableContent = z.strictObject({
	title: TITLE.optional(),
	rows: z
		.array(z.strictObject({ input: CELL.optional(), expected: CELL.optional() }))
		.max(REQUIREMENT_PICTURE_LIMITS.tableRows),
});

const ALT = z.string().max(REQUIREMENT_PICTURE_LIMITS.altChars);

/** `PUT /api/projects/:id/requirements/:req/revisions/:n/picture`: the revision's one picture, written or replaced whole. */
export const writePictureRequestSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("flow"), alt: ALT, content: flowContent }),
	z.strictObject({ kind: z.literal("example_table"), alt: ALT, content: exampleTableContent }),
	z.strictObject({ kind: z.literal("wireframe"), alt: ALT, content: wireframeContent }),
	z.strictObject({ kind: z.literal("chart"), alt: ALT, content: chartContent }),
]);
export type WritePictureRequest = z.infer<typeof writePictureRequestSchema>;
export type PictureContent = WritePictureRequest["content"];
export type ExampleTableContent = z.infer<typeof exampleTableContent>;
export const WRITE_PICTURE_SHAPE =
	'{ kind: flow | example_table | wireframe | chart (process, rule, screen and report take one each), alt: a short text alternative, content: flow { title?, nodes: [{ id, label }], edges: [{ from, to, label? }] } | example_table { title?, rows: [{ input, expected }] } | wireframe { board: a wireframe-v1 board } | chart { variant, x, y: [...], series?, title?, frame: { fields: [{ name, label, type }], rows } of sample figures } }';

/** `PUT …/revisions/:n/kind`: the revision's kind, set or corrected; null clears it. */
export const writeKindRequestSchema = z.strictObject({
	kind: z.enum(REQUIREMENT_KINDS).nullable(),
});
export const WRITE_KIND_SHAPE = `{ kind: ${REQUIREMENT_KINDS.join(" | ")} | null }`;

/** The kind a revision write may carry: absent keeps what is there (the head's, on a new revision), null clears it. */
export const revisionKindField = z.enum(REQUIREMENT_KINDS).nullable().optional();

/**
 * One picture as every door shows it. `roughSketch` is always true: every picture is labelled a
 * rough sketch, not final design, wherever it is drawn (BC-11). A chart's figures are sample.
 */
export interface RequirementPictureView {
	id: string;
	kind: PictureKind;
	content: PictureContent;
	/** What a screen reader reads in its place (BC-12). */
	alt: string;
	roughSketch: true;
	/** The revision it was drawn for; a later revision of the same kind carries it until redrawn. */
	drawnFor: number;
	writtenBy: string;
	writtenByName: string | null;
	writtenAgency: "human" | "agent";
	writtenAt: string;
}
