// A room agent's look at a screen (ISS-1356; owner 2026-11-19: "it confirms UI that is not there").
// Before it tells a person a button, menu item, field or page exists, appears or behaves a certain
// way, the room agent opens a Forge Box on one of its project's environments and looks: the box's
// accessibility snapshot, its screenshot, and the box's own address a person can watch it at. One
// act, through the grants a master's boxes use; it reaches only the room's own project's environments.

import { z } from "zod";
import { supportThreadIdSchema } from "./support.js";

/** The most arguments one browser command a look runs takes. */
export const SUPPORT_LOOK_COMMAND_MAX = 8;

/** The screen sizes a look opens at: a desktop browser's, or a phone's. */
export const SUPPORT_LOOK_VIEWPORTS = {
	desktop: { width: 1440, height: 900 },
	phone: { width: 390, height: 844 },
} as const;

/** How long a look waits for a box it opened to answer before it says it is still opening. */
export const SUPPORT_LOOK_READY_SECONDS = 30;

/**
 * `look`: open a box on one of the project's environments and look (`environment`, `path`), or look
 * again on the box an earlier look opened (`box`), after one browser command (`step`), closing it
 * once done (`close`).
 */
export const supportLookRequestSchema = z.strictObject({
	thread: supportThreadIdSchema,
	environment: z
		.string()
		.regex(/^[a-z][a-z0-9-]{0,62}$/, "an environment the project declares")
		.optional()
		.describe(
			"a first look: the environment of your project whose screen you look at, as it declares it (staging, production)",
		),
	path: z
		.string()
		.trim()
		.min(1)
		.max(500)
		.regex(/^\/[^\s]*$/, "a path on the environment, e.g. /settings/suppliers")
		.optional()
		.describe("a first look: the page's path there; its root where omitted"),
	viewport: z
		.enum(["desktop", "phone"])
		.optional()
		.describe(
			"a first look: desktop (1440×900, the default) or phone (390×844)",
		),
	box: z
		.uuid()
		.optional()
		.describe("a look again: the box an earlier look of this room opened"),
	step: z
		.array(z.string().min(1).max(500))
		.min(1)
		.max(SUPPORT_LOOK_COMMAND_MAX)
		.optional()
		.describe(
			'a look again: one browser command run first, e.g. ["click", "@e12"] (a ref from the snapshot) or ["open", "<an address on the same environment>"]',
		),
	close: z
		.boolean()
		.optional()
		.describe("a look again: close the box once this look is taken"),
});
export type SupportLookRequest = z.infer<typeof supportLookRequestSchema>;

export const SUPPORT_LOOK_SHAPE =
	"{ thread, environment, path?, viewport? } for a first look, or { thread, box, step?, close? } to look again";

/** What a look answers: what the screen showed, and where a person watches the box. */
export interface SupportLookView {
	box: string;
	/** The box's state: `agent` once it answered, else still `opening` or `waiting` for room. */
	state: string;
	/** The address the screen stood at when it was looked at; null until it answers. */
	url: string | null;
	/** The page's accessibility snapshot, each element with the ref a command names it by. */
	snapshot: string | null;
	/** What the screenshot answered: the file it was written to, on the device the box runs on. */
	shot: string | null;
	/** Where a person watches the box, or takes it over, on Forge's web app. */
	watch: string;
	closed: boolean;
}
