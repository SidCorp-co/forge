// A room agent's way to record a term a person names (ISS-1256 c9): a person calls a thing of the
// product by a word of their own, and the room agent writes it into the project's glossary under its
// module, their word an alias and their message quoted as who named it, so the next search in their
// words finds it. Before it, the room agent was told to pass the word on through `record`, which
// files a defect, feature or request after asking the person, and no term was ever written.

import { z } from "zod";
import { termAliasesSchema } from "./module-map.js";
import { supportProjectSlugSchema, supportThreadIdSchema } from "./support.js";

/** `term`: one glossary entry of the project, written by the room agent on the person's word. */
export const supportTermRequestSchema = z.strictObject({
	thread: supportThreadIdSchema,
	message: supportThreadIdSchema.describe(
		"the person's message naming the thing, as you were handed it (`message`): it is quoted as who named it, and the write runs under their Forge permission",
	),
	project: supportProjectSlugSchema.optional(),
	slug: z
		.string()
		.trim()
		.min(1)
		.max(120)
		.regex(/^[a-z0-9][a-z0-9-]*$/, "a kebab-case slug, e.g. run-slots")
		.describe("the term's slug, kebab-case: an existing one is rewritten"),
	title: z
		.string()
		.trim()
		.min(1)
		.max(200)
		.describe("the term as the project names the thing"),
	means: z
		.string()
		.trim()
		.min(1)
		.max(1000)
		.describe("what the term names, in one or two sentences"),
	module: z
		.string()
		.trim()
		.min(1)
		.max(128)
		.describe("the business module the thing belongs to, by its slug"),
	aliases: termAliasesSchema
		.optional()
		.describe(
			"the person's word and the thing's other names: vi, code, industry",
		),
	quote: z
		.string()
		.trim()
		.min(1)
		.max(600)
		.describe("the person's own words naming it, as they wrote them"),
	anchor: z
		.string()
		.trim()
		.min(1)
		.max(600)
		.optional()
		.describe("where it lives in code, `file.ts:symbol`, where you know it"),
});
export type SupportTermRequest = z.infer<typeof supportTermRequestSchema>;
