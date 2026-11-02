// The labels a requirement's goal states its problem, value, measure and roadmap lane under, in the
// language the requirement is written in (`./written-lang.ts`). A text is kept as it was written and
// never translated (adminhub-api REQ-2 on dev, 2026-10-22, was written in Vietnamese and refused for
// want of "Value:"), so its labels are read in its own language, and the English ones in any. Core's
// ready checklist and the requirement page read a goal through the one parser here (`goalAnswers`).

import { type WrittenLang, writtenLangOfText } from "./written-lang.js";

export const GOAL_LABELS = ["problem", "value", "measured", "roadmap"] as const;
export type GoalLabel = (typeof GOAL_LABELS)[number];

/** Each label as a line of the goal starts with it, before its colon. */
export const GOAL_LABEL_WORDS: Readonly<
	Record<WrittenLang, Readonly<Record<GoalLabel, string>>>
> = {
	en: { problem: "Problem", value: "Value", measured: "Measured by", roadmap: "Roadmap" },
	vi: {
		problem: "Vấn đề", // i18n-allow: the label a Vietnamese requirement writes
		value: "Giá trị", // i18n-allow: the label a Vietnamese requirement writes
		measured: "Đo bằng", // i18n-allow: the label a Vietnamese requirement writes
		roadmap: "Lộ trình", // i18n-allow: the label a Vietnamese requirement writes
	},
};

/** The label words a goal written in `lang` is read under: its own language's first, then English. */
export function goalLabelWords(lang: WrittenLang | null | undefined, label: GoalLabel): string[] {
	const own = lang && lang !== "en" ? [GOAL_LABEL_WORDS[lang][label]] : [];
	return [...own, GOAL_LABEL_WORDS.en[label]];
}

const escaped = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The patterns a line of a goal written in `lang` opens with, per label: its own language's and English. */
function labelPatterns(lang: WrittenLang | null): [GoalLabel, RegExp][] {
	return GOAL_LABELS.map((label) => [
		label,
		new RegExp(`^(?:${goalLabelWords(lang, label).map(escaped).join("|")})\\s*:\\s*`, "iu"),
	]);
}

/**
 * The goal's labelled lines (`Problem:`, `Value:`, `Measured by:`, `Roadmap:`), read under the labels
 * of the language the requirement is written in and the English ones. A label's text is what follows
 * it on its line, and an indented line directly under it, with no blank line between, continues that
 * text. A label with nothing after its colon takes the non-empty lines below it, indented or not,
 * as written (list markers kept), up to a blank line or the next label (ISS-770); one followed
 * directly by a label, a blank line or the end states nothing. Where no `Problem:` line states it, every other line (unlabelled and not such a continuation)
 * states the problem, wherever it stands, so a goal that labels nothing answers the problem alone and
 * adding a `Value:` line above, between or below never takes that answer away (forge-dev REQ-5 r5,
 * 2026-10-28; ISS-732 c1). A line directly under a label that has text of its own, and is not
 * indented, is the problem, not more of that label.
 */
export function goalAnswers(
	goal: string | null | undefined,
	lang: WrittenLang | null = null,
): Partial<Record<GoalLabel, string>> {
	const text = goal?.normalize("NFC").trim() ?? "";
	if (text === "") return {};
	const patterns = labelPatterns(lang ?? writtenLangOfText(text));
	const said: Partial<Record<GoalLabel, string[]>> = {};
	const unlabelled: string[] = [];
	// The lines the label just read keeps, which an indented line directly below continues. A label
	// with nothing after its colon (`bare`) is continued by every non-empty line below it.
	let open: string[] | null = null;
	let bare = false;
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line === "") {
			open = null;
			bare = false;
			continue;
		}
		const hits = patterns.filter(([, pattern]) => pattern.test(line));
		if (hits.length === 0) {
			if (open !== null && (bare || /^\s/.test(raw))) open.push(line);
			else {
				unlabelled.push(line);
				open = null;
				bare = false;
			}
			continue;
		}
		open = null;
		bare = false;
		for (const [label, pattern] of hits) {
			if ((said[label]?.length ?? 0) > 0) {
				open = []; // a repeated label states nothing, and neither does its continuation
				continue;
			}
			const own = line.replace(pattern, "").trim();
			open = own === "" ? [] : [own];
			bare = own === "";
			said[label] = open;
		}
	}
	const found: Partial<Record<GoalLabel, string>> = {};
	for (const label of GOAL_LABELS) {
		const lines = said[label];
		if (lines !== undefined && lines.length > 0) found[label] = lines.join("\n");
	}
	if (found.problem === undefined && unlabelled.length > 0) found.problem = unlabelled.join("\n");
	return found;
}
