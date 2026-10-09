// The release notes as a customer is handed them: each section's user-facing lines and nothing an
// engineer wrote for themselves. An issue key or internal path inside brackets goes with its
// brackets; a note whose sentence itself carries an engineer's handle is held back, named, for its
// writer to rewrite, never cut into a broken sentence. An issue whose title names another issue of
// the same release ships that issue's change (a publish or a carrier), so its line folds into the
// change it ships; two notes that say the same thing keep one line. Read by the release page
// (`packages/core/src/release-page/sections.ts`), which gathers its improvements and fixes from it.

import { releaseNoteReferences } from "./content-language.js";
import type { ReleaseNoteSection } from "./releases.js";

export interface CustomerNotesSection {
	section: string;
	lines: string[];
}

export interface CustomerNotesView {
	sections: CustomerNotesSection[];
	/** Notes left out because another line already says it: the issue that ships it, or the same words. */
	folded: { key: string; why: "carries" | "duplicate"; into: string[] }[];
	/** Notes held back because their sentence names what a customer cannot follow, with what each names. */
	held: { key: string; references: string[] }[];
}

const KEY = /\b(?:ISS|REQ|FB)-\d+\b/g;
// a path into the product or its API (`/pages/reports`, `/hop/campaigns/sign?x=1`), never a date
// or a fraction: it opens with a slash after a space or a bracket and a letter after the slash
const PATH = /(?<=^|[\s(])\/[A-Za-z][^\s),;]*[^\s),;.:!?]/g;
// a bracketed aside holding no nested bracket
const ASIDE = /\s*\(([^()]*)\)/g;

const pathsIn = (text: string): string[] => text.match(PATH) ?? [];

/** The handles a customer cannot follow in `text`, each named as it reads. */
function handlesIn(text: string): string[] {
	return [
		...releaseNoteReferences(text),
		...pathsIn(text).map((p) => `path ${p}`),
	];
}

/** `text` without the bracketed asides that hold a handle, tidied; the rest is kept as written. */
function withoutAsides(text: string): string {
	return text
		.replace(ASIDE, (aside, inner: string) =>
			handlesIn(inner).length > 0 ? "" : aside,
		)
		.replace(/\s+([,.;:!?])/g, "$1")
		.replace(/\s{2,}/g, " ")
		.trim();
}

const sameWords = (text: string) =>
	text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();

export function customerNotes(
	sections: readonly ReleaseNoteSection[],
): CustomerNotesView {
	const noted = new Set(sections.flatMap((s) => s.entries.map((e) => e.key)));
	const folded: CustomerNotesView["folded"] = [];
	const held: CustomerNotesView["held"] = [];
	const said = new Map<string, string>();
	const out: CustomerNotesSection[] = [];
	for (const s of sections) {
		const lines: string[] = [];
		for (const e of s.entries) {
			const carried = [...new Set(e.title.match(KEY) ?? [])].filter(
				(k) => k !== e.key && noted.has(k),
			);
			if (carried.length > 0) {
				folded.push({ key: e.key, why: "carries", into: carried });
				continue;
			}
			const line = withoutAsides(e.userFacing);
			const left = handlesIn(line);
			if (left.length > 0) {
				held.push({ key: e.key, references: left });
				continue;
			}
			const words = sameWords(line);
			const first = said.get(words);
			if (first) {
				folded.push({ key: e.key, why: "duplicate", into: [first] });
				continue;
			}
			said.set(words, e.key);
			lines.push(line);
		}
		if (lines.length > 0) out.push({ section: s.section, lines });
	}
	return { sections: out, folded, held };
}

// words a user-facing line uses when the build it describes is a demo, a dev build or runs on test
// data, in English and as the project's Vietnamese notes write them
const DEMO_WORDS =
	/\b(?:demo|dev (?:site|build)|test data)\b|bản dev|site dev|dữ liệu test|bản demo/iu; // i18n-allow: the words HOP's notes use

/** The issues whose user line calls the build a demo, a dev build or test data: a label saying production contradicts them. */
export function notesCallingItDemo(
	sections: readonly ReleaseNoteSection[],
): string[] {
	return sections.flatMap((s) =>
		s.entries.filter((e) => DEMO_WORDS.test(e.userFacing)).map((e) => e.key),
	);
}
