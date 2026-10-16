// A record's title as a write takes it: trimmed, not blank, and bounded, each refusal in plain words
// naming the bound, never zod's own text ("Too big: expected string to have <=500 characters"). And
// a stored text as a list row shows it: one line, cut at a whole word where it runs past the row's
// bound. A row's cut is a display rule; the record keeps its whole text, read on its own page.
import { z } from "zod";

/** The longest title a requirement takes; the title input holds a person to it before a save. */
export const REQUIREMENT_TITLE_MAX = 500;

/** A title field of at most `max` characters, refused in words a person reads. */
export const titleText = (max: number) =>
	z
		.string()
		.trim()
		.min(1, "The title is blank: say in a few words what this is.")
		.max(max, `The title is longer than ${max} characters: shorten it to ${max} or fewer.`);

/** The text on one line: every run of whitespace, newlines included, read as one space. */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * `text` on one line, and where that runs past `max` characters, the whole words that fit with an
 * ellipsis after them. A first word longer than `max` is the one case cut inside a word: there is
 * no boundary to cut at.
 */
export function cutAtWord(text: string, max: number): string {
	const line = oneLine(text);
	if (line.length <= max) return line;
	const space = line.lastIndexOf(" ", max - 1);
	const kept = space > 0 ? line.slice(0, space) : line.slice(0, max - 1);
	return `${kept}…`;
}

/**
 * A comment's short form, as a list of them shows each: its first line that says anything, up to the
 * end of its first sentence, cut at a whole word to `max`. The body stays on the thread it was written in.
 */
export function shortForm(text: string, max: number): string {
	const first = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
	const sentence = /^.*?[.?!](?=\s|$)/.exec(first.trim())?.[0] ?? first;
	return cutAtWord(sentence, max);
}
