// The labels a requirement's goal states its problem, value, measure and roadmap lane under, in the
// language the requirement is written in (`./written-lang.ts`). A text is kept as it was written and
// never translated (adminhub-api REQ-2 on dev, 2026-10-22, was written in Vietnamese and refused for
// want of "Value:"), so its labels are read in its own language, and the English ones in any.

import type { WrittenLang } from "./written-lang.js";

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
