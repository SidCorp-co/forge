// The release notes as a customer is handed them: each section's user-facing lines and nothing an
// engineer wrote for themselves. An issue key or internal path inside brackets goes with its
// brackets; a note whose sentence itself carries an engineer's handle is held back, named, for its
// writer to rewrite, never cut into a broken sentence. On a release still to ship, a note with no
// short title, or one saying more or less than one sentence, is held the same way until its writer
// fixes it (REQ-70 BC-3); a release that ended reads its notes as they were when it ended, a note
// written before titles shown as its whole sentence. An issue whose title names another issue of
// the same release ships that issue's change (a publish or a carrier), so its line folds into the
// change it ships; two notes that say the same thing keep one line. Read by the release page
// (`packages/core/src/release-page/sections.ts`), which gathers its improvements and fixes from it.

import { releaseNoteReferences } from "./content-language.js";
import {
	type ReleaseNoteUnwritten,
	releaseNoteUnwritten,
} from "./release-notes.js";
import type { ReleaseNoteSection } from "./releases.js";

/**
 * One change as a customer reads it: `line` is the note's short title, `detail` the sentence that says
 * it in full; on a release that ended, a note written before titles is its whole sentence as `line`,
 * with no `detail`. Neither is cut.
 */
export interface CustomerNoteLine {
	key: string;
	line: string;
	detail: string | null;
}

export interface CustomerNotesSection {
	section: string;
	lines: CustomerNoteLine[];
}

export interface CustomerNotesView {
	sections: CustomerNotesSection[];
	/** Notes left out because another line already says it: the issue that ships it, or the same words. */
	folded: { key: string; why: "carries" | "duplicate"; into: string[] }[];
	/** Notes held back because their sentence names what a customer cannot follow, with what each names. */
	held: { key: string; references: string[] }[];
	/** Notes held back until their writer gives them a short title or says them in one sentence. */
	unwritten: { key: string; why: ReleaseNoteUnwritten }[];
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
	release: { ended: boolean } = { ended: false },
): CustomerNotesView {
	const noted = new Set(sections.flatMap((s) => s.entries.map((e) => e.key)));
	const folded: CustomerNotesView["folded"] = [];
	const held: CustomerNotesView["held"] = [];
	const unwritten: CustomerNotesView["unwritten"] = [];
	const said = new Map<string, string>();
	const out: CustomerNotesSection[] = [];
	for (const s of sections) {
		const lines: CustomerNoteLine[] = [];
		for (const e of s.entries) {
			const carried = [...new Set(e.title.match(KEY) ?? [])].filter(
				(k) => k !== e.key && noted.has(k),
			);
			if (carried.length > 0) {
				folded.push({ key: e.key, why: "carries", into: carried });
				continue;
			}
			const owed = release.ended
				? null
				: releaseNoteUnwritten({ title: e.heading, userFacing: e.userFacing });
			if (owed) {
				unwritten.push({ key: e.key, why: owed });
				continue;
			}
			const sentence = withoutAsides(e.userFacing);
			const line = e.heading ? withoutAsides(e.heading) : sentence;
			const detail = e.heading ? sentence : null;
			const left = [...handlesIn(line), ...handlesIn(detail ?? "")];
			if (left.length > 0) {
				held.push({ key: e.key, references: [...new Set(left)] });
				continue;
			}
			const words = sameWords(`${line} ${detail ?? ""}`);
			const first = said.get(words);
			if (first) {
				folded.push({ key: e.key, why: "duplicate", into: [first] });
				continue;
			}
			said.set(words, e.key);
			lines.push({ key: e.key, line, detail });
		}
		if (lines.length > 0) out.push({ section: s.section, lines });
	}
	return { sections: out, folded, held, unwritten };
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
		s.entries
			.filter((e) => DEMO_WORDS.test(`${e.heading ?? ""} ${e.userFacing}`))
			.map((e) => e.key),
	);
}
