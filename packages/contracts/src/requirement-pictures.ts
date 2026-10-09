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

/** One picture of each kind, its text alternative taken as `alt` says. */
const pictureOf = <A extends z.ZodType<string | undefined>>(alt: A) =>
	z.discriminatedUnion("kind", [
		z.strictObject({ kind: z.literal("flow"), alt, content: flowContent }),
		z.strictObject({ kind: z.literal("example_table"), alt, content: exampleTableContent }),
		z.strictObject({ kind: z.literal("wireframe"), alt, content: wireframeContent }),
		z.strictObject({ kind: z.literal("chart"), alt, content: chartContent }),
	]);

/** `PUT /api/projects/:id/requirements/:req/revisions/:n/picture`: the revision's one picture, written or replaced whole. */
export const writePictureRequestSchema = pictureOf(ALT);
export type WritePictureRequest = z.infer<typeof writePictureRequestSchema>;
export type PictureContent = WritePictureRequest["content"];
export type ExampleTableContent = z.infer<typeof exampleTableContent>;
export const WRITE_PICTURE_SHAPE =
	'{ kind: flow | example_table | wireframe | chart (process, rule, screen and report take one each), alt: a short text alternative, content: flow { title?, nodes: [{ id, label }], edges: [{ from, to, label? }] } | example_table { title?, rows: [{ input, expected }] } | wireframe { board: a wireframe-v1 board } | chart { variant, x, y: [...], series?, title?, frame: { fields: [{ name, label, type }], rows } of sample figures } }';

/**
 * The picture a revision write carries, drawn with its draft (r14 `revision.written`, BC-10): the
 * same kinds and content as the page's, written in the same transaction as the revision. Its text
 * alternative may be left out, and is then written from the content (`describePicture`), so the
 * assistant's picture never stands without one (BC-12); one given blank is refused by name in core.
 */
export const draftPictureSchema = pictureOf(ALT.optional());
export type DraftPicture = z.infer<typeof draftPictureSchema>;
export const DRAFT_PICTURE_SHAPE =
	"{ kind: flow | example_table | wireframe | chart (process, rule, screen and report take one each), content: as the picture route takes it, alt?: left out, it is written from the content }";

/** What the assistant's draft tools tell the model of the kind it names, on the field it fills. */
export const DRAFT_KIND_HOW =
	"what the requirement is: process (a flow of steps), rule (a rule with examples), screen (what a screen shows) or report (figures over time); its picture follows from it";
/** What the assistant's draft tools tell the model of the picture it draws, on the field it fills. */
export const DRAFT_PICTURE_HOW =
	"its picture, a rough sketch: a process takes { kind: flow, content: { title?, nodes: [{ id, label }], edges: [{ from, to, label? }] } }, a rule { kind: example_table, content: { title?, rows: [{ input, expected }] } }, a screen { kind: wireframe, content: { board: a wireframe-v1 board } }, a report { kind: chart, content: { variant, x, y: [...], frame: { fields, rows } of sample figures } }. Leave alt out: its text alternative is written from the content.";

/** A flow's steps as its edges join them, else as listed. */
function flowWords(flow: Extract<DraftPicture, { kind: "flow" }>["content"]): string {
	const label = new Map(flow.nodes.map((n) => [n.id, n.label]));
	const steps = flow.nodes.length === 1 ? "1 step" : `${flow.nodes.length} steps`;
	const joins = flow.edges.map(
		(e) => `${label.get(e.from) ?? e.from} to ${label.get(e.to) ?? e.to}${e.label ? ` (${e.label})` : ""}`,
	);
	return `a flow of ${steps}: ${joins.length ? joins.join(", ") : flow.nodes.map((n) => n.label).join(", ")}`;
}

function tableWords(table: ExampleTableContent): string {
	const rows = table.rows.map((r) => `${r.input?.trim() || "?"} gives ${r.expected?.trim() || "?"}`);
	return `an example table of ${table.rows.length === 1 ? "1 row" : `${table.rows.length} rows`}: ${rows.join("; ")}`;
}

/** What each shape on a board says, by its own words; a board of bare shapes is counted. */
function boardWords(board: unknown): string {
	const parsed = parseWireframe(board);
	if (!parsed.ok) return "a wireframe";
	const said = parsed.doc.shapes.flatMap((s): string[] => {
		switch (s.type) {
			case "text":
				return [`"${s.text}"`];
			case "button":
				return s.label ? [`a ${s.label} button`] : ["a button"];
			case "input":
				return [s.label ? `a ${s.label} input` : s.placeholder ? `an input for ${s.placeholder}` : "an input"];
			case "list":
				return [`${s.label ? `a ${s.label} list` : "a list"} of ${s.items.length}`];
			case "frame":
			case "image":
				return s.label ? [`${s.type === "image" ? "an image of " : ""}${s.label}`] : [];
			default:
				return [];
		}
	});
	const title = parsed.doc.title ? ` "${parsed.doc.title}"` : "";
	const shapes = parsed.doc.shapes.length === 1 ? "1 shape" : `${parsed.doc.shapes.length} shapes`;
	return `a wireframe${title}: ${said.length ? said.join(", ") : shapes}`;
}

function chartWords(chart: Extract<DraftPicture, { kind: "chart" }>["content"]): string {
	const label = new Map(chart.frame.fields.map((f) => [f.name, f.label]));
	const named = (f: string) => label.get(f) ?? f;
	const per = chart.series ? `, one series per ${named(chart.series)}` : "";
	const rows = chart.frame.rows.length === 1 ? "1 sample row" : `${chart.frame.rows.length} sample rows`;
	return `a sample ${chart.variant} chart of ${chart.y.map(named).join(" and ")} by ${named(chart.x)}${per}, from ${rows}`;
}

/**
 * A picture's text alternative written from its content (BC-12): what it shows, in one sentence a
 * screen reader reads in its place. Never empty, and within the alt limit.
 */
export function describePicture(picture: DraftPicture): string {
	const titled = "title" in picture.content && picture.content.title ? `${picture.content.title}: ` : "";
	const words =
		picture.kind === "flow"
			? flowWords(picture.content)
			: picture.kind === "example_table"
				? tableWords(picture.content)
				: picture.kind === "wireframe"
					? boardWords(picture.content.board)
					: chartWords(picture.content);
	const sentence = `${titled}${titled ? words : words.charAt(0).toUpperCase() + words.slice(1)}.`;
	const max = REQUIREMENT_PICTURE_LIMITS.altChars;
	return sentence.length <= max ? sentence : `${sentence.slice(0, max - 1)}…`;
}

/** The picture as the picture write takes it: its own alt, or one written from its content. */
export function pictureWithAlt(picture: DraftPicture): WritePictureRequest {
	return { ...picture, alt: picture.alt ?? describePicture(picture) } as WritePictureRequest;
}

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
