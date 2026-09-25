/**
 * The two allow-lists a browser stages files against, so there is one of each
 * rather than one per package.
 *
 * A composer decides what it will stage before it uploads anything, and it has
 * to decide it against the same list the server enforces: a second copy drifts
 * in the direction that costs the person the file, staging a type core no
 * longer takes and losing it at the PUT under a refusal the composer never
 * printed (ISS-1146).
 *
 * The issue and comment lists stay in core, where they are enforced: nothing in
 * a browser stages against them.
 */

/**
 * What a conversation takes: pictures and nothing else, because
 * `assistant/vision.ts` is what reads a conversation's files and it re-sends
 * images. `image/svg+xml` is out — markup rather than a picture, and it carries
 * script.
 */
export const CONVERSATION_MIMES = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
] as const;

/** What an agent session takes: what a runner can open on the box. */
export const SESSION_MIMES = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/svg+xml",
	"text/html",
	"application/pdf",
	"text/plain",
	"text/markdown",
] as const;
