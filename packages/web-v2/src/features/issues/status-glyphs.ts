import type { IssueStatus } from "./types";

/** The legend glyph per status (ISS-54): a mark, not a word, so `one-status-vocabulary.test.ts` exempts it. */
export const STATUS_GLYPHS: Record<IssueStatus, string> = {
	draft: "○",
	open: "●",
	reopen: "↺",
	in_progress: "●",
	approved: "◆",
	needs_info: "?",
	on_hold: "‖",
	awaiting_release: "↑",
	closed: "✓",
	dropped: "×",
};

export const statusGlyph = (s: IssueStatus): string => STATUS_GLYPHS[s] ?? "●";
