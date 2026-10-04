// One declaration of the system graph a system-context design reads as (ISS-153, REQ-12
// BC-10): core derives it once, and the web's C4 view and the overview's header facts read it from here.

import { z } from "zod";
import { templateEdgeKindSchema } from "./workflow-template-schema.js";

/** The template whose designs read as a system graph. */
export const SYSTEM_CONTEXT_TEMPLATE = "system-context";

/**
 * What an element is on a C4 diagram: a person; the in-scope system's own `system` or `container`
 * (inside its boundary); or an `external` element, anything else that is not a person.
 */
export const GRAPH_NODE_KINDS = [
	"person",
	"system",
	"container",
	"external",
] as const;
export type NodeKind = (typeof GRAPH_NODE_KINDS)[number];

/** Whether a design states an outside system's integration as settled. */
export const INTEGRATION_STATES = ["confirmed", "unconfirmed"] as const;
export type IntegrationState = (typeof INTEGRATION_STATES)[number];

/** A design lane splits by side: the people in it, the in-scope system's parts, or outside elements. */
export const BOUNDARY_SIDES = ["people", "focal", "outside"] as const;
export type BoundarySide = (typeof BOUNDARY_SIDES)[number];

export const SYSTEM_GRAPH_REFUSAL_CODES = [
	"SYSTEM_GRAPH_NOT_SYSTEM_CONTEXT",
	"SYSTEM_GRAPH_REVISION_UNKNOWN",
] as const;
export type SystemGraphRefusalCode =
	(typeof SYSTEM_GRAPH_REFUSAL_CODES)[number];

export const graphNodeSchema = z.strictObject({
	id: z.string(),
	kind: z.enum(GRAPH_NODE_KINDS),
	/** The design's label; `name` drops an unconfirmed aside from an external's. */
	title: z.string(),
	name: z.string(),
	purpose: z.string(),
	owner: z.string().nullable(),
	/** The design lane it sits in. */
	boundary: z.string().nullable(),
	integration: z.enum(INTEGRATION_STATES).nullable(),
	/** The words the integration state was read from, for its badge's tooltip. */
	mark: z.string().nullable(),
	/** Drawn only to show what a revision removed: it is in the compared revision, not this one. */
	removed: z.boolean(),
});
export type GraphNode = z.infer<typeof graphNodeSchema>;

/** One relationship the design draws, with its own words and what it runs over. */
export const relationshipSchema = z.strictObject({
	id: z.string(),
	from: z.string(),
	to: z.string(),
	label: z.string(),
	technology: z.string().nullable(),
	kind: templateEdgeKindSchema,
});
export type Relationship = z.infer<typeof relationshipSchema>;

export const boundarySchema = z.strictObject({
	/** `<side>:<lane>`. */
	id: z.string(),
	lane: z.string(),
	side: z.enum(BOUNDARY_SIDES),
	label: z.string(),
	tip: z.string(),
	members: z.array(z.string()),
});
export type Boundary = z.infer<typeof boundarySchema>;

/** The software system the design is about. */
export const focalSystemSchema = z.strictObject({
	boundary: z.string().nullable(),
	title: z.string(),
	tip: z.string(),
	/** What the system is, in the design's own words: the in-scope system's stated `purpose`, else empty. */
	purpose: z.string(),
	parts: z.array(z.string()),
});
export type FocalSystem = z.infer<typeof focalSystemSchema>;

export const factRowSchema = z.strictObject({
	name: z.string(),
	count: z.number().int().optional(),
	unconfirmed: z.number().int().optional(),
});
export type FactRow = z.infer<typeof factRowSchema>;

/** What the overview's header states, counted once here. */
export const graphFactsSchema = z.strictObject({
	people: z.array(factRowSchema),
	externals: z.number().int(),
	/** Outside elements by boundary, in lane order, those in no boundary last. */
	boundaries: z.array(factRowSchema),
	namedBoundaries: z.number().int(),
});
export type GraphFacts = z.infer<typeof graphFactsSchema>;

/** `GET /api/projects/:id/workflows/:workflow/system-graph?revision=&against=`. */
export const systemGraphSchema = z.strictObject({
	workflowId: z.string(),
	revision: z.number().int(),
	/** The revision whose removed elements are drawn too, when one was asked for. */
	against: z.number().int().nullable(),
	focal: focalSystemSchema.nullable(),
	nodes: z.array(graphNodeSchema),
	relationships: z.array(relationshipSchema),
	boundaries: z.array(boundarySchema),
	facts: graphFactsSchema,
});
export type SystemGraph = z.infer<typeof systemGraphSchema>;
