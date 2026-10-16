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

/** A line opening or closing a fenced code block. */
const FENCE = /^\s{0,3}(?:`{3,}|~{3,})/;
/** A thematic break: three or more of one of `-`, `*`, `_`, alone on the line. */
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
/** A code span: its text is kept as written, the markers inside it are not read as markup. */
const CODE_SPAN = /(`+)(.+?)\1(?!`)/g;
/** A code span set aside while the rest is unmarked: private-use characters no markup rule matches. */
const HELD = /\uE000(\d+)\uE001/g;

/**
 * What a line's inline markup draws, each marker read as CommonMark reads it: `*`/`_` only where
 * they open and close emphasis (`_` never inside a word, so `snake_case_name` and `2 * 3` stay),
 * a link or image as its text, an autolink as its address, a backslash escape as its character.
 */
const INLINE: [RegExp, string][] = [
	[/!?\[([^\]]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, "$1"],
	[/<((?:https?|mailto):[^>\s]+)>/g, "$1"],
	[/(?<!\\)\*\*(?=\S)(.+?)(?<=[^\s\\])\*\*/g, "$1"],
	[/(?<![\p{L}\p{N}_\\])__(?=\S)(.+?)(?<=[^\s\\])__(?![\p{L}\p{N}_])/gu, "$1"],
	[/(?<![*\\])\*(?=[^\s*])(.+?)(?<=[^\s*\\])\*(?!\*)/g, "$1"],
	[/(?<![\p{L}\p{N}_\\])_(?=[^\s_])(.+?)(?<=[^\s_\\])_(?![\p{L}\p{N}_])/gu, "$1"],
	[/(?<!\\)~~(?=\S)(.+?)(?<=\S)~~/g, "$1"],
	[/\\([!-/:-@[-`{-~])/g, "$1"],
];

/**
 * One markdown line as the words it draws, on one line: no blockquote `>`, heading hashes, list
 * bullet, number or task box, and no inline markers (`INLINE`). A code span keeps its text.
 */
function plainLine(line: string): string {
	let text = line.replace(/^\s*(?:>\s?)+/, "");
	const heading = /^\s{0,3}#{1,6}(?:\s+|$)/;
	if (heading.test(text)) text = text.replace(heading, "").replace(/(?:^|\s+)#+\s*$/, "");
	text = text.replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/, "");
	const held: string[] = [];
	text = text.replace(CODE_SPAN, (_, _ticks: string, code: string) => `\uE000${held.push(code.trim()) - 1}\uE001`);
	for (const [rule, kept] of INLINE) text = text.replace(rule, kept);
	return oneLine(text.replace(HELD, (_, i: string) => held[Number(i)] ?? ""));
}

/**
 * A comment's short form, as a list of them shows each: its first line that says anything, as plain
 * words (`plainLine`), up to the end of its first sentence, cut at a whole word to `max`. A line that
 * is only markup — a fence and the code it holds, a rule, an empty heading — says nothing. The body
 * stays on the thread it was written in.
 */
export function shortForm(text: string, max: number): string {
	let fenced = false;
	let first = "";
	for (const line of text.split(/\r?\n/)) {
		if (FENCE.test(line)) {
			fenced = !fenced;
			continue;
		}
		if (fenced || RULE.test(line)) continue;
		first = plainLine(line);
		if (first !== "") break;
	}
	const sentence = /^.*?[.?!](?=\s|$)/.exec(first)?.[0] ?? first;
	return cutAtWord(sentence, max);
}
